import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { reportAtlasInitializationProgress as reportProgress, type AtlasInitializationProgressCallback } from "./initialization-progress.ts";
import { atlasLocaleBlock, defaultAtlasLocale, type AtlasLocale } from "./locale.ts";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { candidateFile } from "./candidate-gallery.ts";
import type { Game } from "./catalog.ts";
import { evidenceObject, parseLegacyJsonEvidence, serializeLegacyJsonEvidence } from "./legacy-json-evidence.ts";
import { roleMaterialGroups } from "./role-data.ts";
import { atlasSourceOrigin, isAtlasSourceWebp, readAtlasSourceBytes, type AtlasSourceFetch } from "./source-transport.ts";
import { label, object } from "./source-values.ts";
import type { AtlasCandidatePage } from "./validate-candidate.ts";

const materialVersion = /^[0-9]+(?:\.[0-9]+){1,3}(?:\+[0-9]+)?$/u;
const itemId = /^[1-9]\d{0,11}$/u;
const maxTableBytes = 16 * 1024 * 1024;
const maxIconBytes = 8 * 1024 * 1024;
const iconFile = /(?:^|\/)([A-Za-z0-9_-]+)(?:\.(?:png|webp))?$/iu;

function characterPage(value: unknown, game: Game, locale: AtlasLocale) {
  const gameData = object(object(object(value).games)[game]);
  const localized = atlasLocaleBlock(gameData, locale);
  return object(object(localized.pages).character);
}

function materialSource(game: Game, id: string, value: unknown) {
  const row = object(value);
  if (game !== "gi" && String(row.id) !== id) return;
  const name = label(game === "hsr" ? row.item_name : row.name);
  if (!name) return;
  const fields = game === "hsr" ? [row.item_figure_icon_path, row.item_icon_path, row.item_currency_icon_path]
    : [game === "gi" ? row.icon : row.icon_path];
  const icons = [...new Set(fields.flatMap((value) => {
    if (typeof value !== "string") return [];
    const filename = iconFile.exec(value)?.[1];
    return filename ? [game === "hsr" ? `itemfigures/${filename}` : filename] : [];
  }))];
  return { name, icons };
}

async function writeAtomic(file: string, data: string | Buffer, signal?: AbortSignal) {
  const parent = dirname(file);
  await mkdir(parent, { recursive: true });
  if (await realpath(parent) !== parent) throw new Error($t("role-material-source.text_8fb2bc7a56"));
  const stage = await mkdtemp(join(parent, ".atlas-material-"));
  try {
    const temporary = join(stage, "data");
    await writeFile(temporary, data, { signal });
    signal?.throwIfAborted();
    await rename(temporary, file);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function loadIcon(root: string, game: Game, icon: string, request: AtlasSourceFetch, signal?: AbortSignal) {
  const localPath = `gallery/${game}/materials/${icon}.webp`;
  const url = `${atlasSourceOrigin}/assets/${game}/${icon}.webp`;
  const readExisting = (path: string) => candidateFile(root, path).then(async (file) => {
    const asset = Bun.file(file);
    if (asset.size <= maxIconBytes) return Buffer.from(await asset.arrayBuffer());
  }).catch(() => undefined);
  const cached = await readExisting(localPath);
  let bytes: Buffer | undefined = cached && isAtlasSourceWebp(cached) ? cached : undefined;
  if (!bytes) {
    const original = await readExisting(`gallery/${game}/${icon}.webp`);
    bytes = original && isAtlasSourceWebp(original) ? original
      : await readAtlasSourceBytes(url, "image/webp", maxIconBytes, true, signal, request, { retry: true });
    if (!bytes) return;
    if (!isAtlasSourceWebp(bytes)) throw new Error($t("role-material-source.text_c7db704020", { "game": game, "icon": icon }));
    await writeAtomic(join(root, localPath), bytes, signal);
  }
  return { status: "downloaded", placeholder: false, localPath, url, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function readRoleMaterials(data: string, path: unknown, recordId: string, game: Game, version: string) {
  if (typeof path !== "string" || !path.startsWith("items/")) throw new Error($t("role-material-source.text_c76f54e0d8"));
  const file = await candidateFile(data, path);
  const raw = await Bun.file(file).text();
  const role = object(JSON.parse(raw));
  const metadata = object(role.meta);
  if (metadata.recordId !== recordId || metadata.gameId !== game || metadata.version !== version || metadata.pageId !== "character") {
    throw new Error($t("role-material-source.text_52c8a331b2", { "game": game, "recordId": recordId }));
  }
  const items = roleMaterialGroups(game, object(object(role.content).detail), metadata.images, metadata.materialNames)
    .flatMap(({ items }) => items).filter((item) => item.id && itemId.test(item.id));
  return { file, raw, items };
}

export async function pendingAtlasRoleMaterials<T extends AtlasCandidatePage>(data: string, pages: readonly T[],
  signal?: AbortSignal, includeArtwork = true) {
  const map = await Bun.file(await candidateFile(data, "map.json")).json();
  const pending: T[] = [];
  for (const page of pages) {
    const { game, pageId, version, locale = defaultAtlasLocale } = page;
    if (pageId !== "character" || !version) continue;
    const source = characterPage(map, game, locale);
    if (source.version !== version) continue;
    for (const [recordId, record] of Object.entries(object(source.records))) {
      signal?.throwIfAborted();
      const { items } = await readRoleMaterials(data, object(record).path, recordId, game, version);
      if (items.some(item => !item.name || includeArtwork && !item.artwork)) {
        pending.push(page);
        break;
      }
    }
  }
  return pending;
}

/** Join exact-version item data only to character records already checked by the source exporter. */
export async function completeAtlasRoleMaterials(root: string, scope: readonly AtlasCandidatePage[],
  signal?: AbortSignal, request: AtlasSourceFetch = fetch, includeArtwork = true, onProgress?: AtlasInitializationProgressCallback) {
  const data = join(root, "data");
  const map = await Bun.file(await candidateFile(data, "map.json")).json();
  await reportProgress(onProgress, { stage: "materials", message: $t("role-material-source.text_b0e5d6e044") }, signal);
  const pending = await pendingAtlasRoleMaterials(data, scope, signal, includeArtwork);
  if (!pending.length) return [];
  const updated: AtlasCandidatePage[] = [];
  for (const { game, version, locale = defaultAtlasLocale } of pending) {
    try {
      if (await completeGameMaterials(root, data, map, game, version, locale, request, signal, includeArtwork, onProgress)) {
        updated.push({ game, pageId: "character", version, ...(locale !== defaultAtlasLocale && { locale }) });
      }
    } catch (error) {
      signal?.throwIfAborted();
      console.warn($t("role-material-source.text_772dae5cf6", { "game": game, "value2": error instanceof Error ? error.message : $t("role-material-source.text_5215599023") }));
    }
  }
  return updated;
}

async function completeGameMaterials(root: string, data: string, map: unknown, game: Game, version: string | undefined, locale: AtlasLocale,
  request: AtlasSourceFetch, signal: AbortSignal | undefined, includeArtwork: boolean, onProgress?: AtlasInitializationProgressCallback) {
  if (!version || !materialVersion.test(version)) throw new Error($t("role-material-source.text_1cb106adcf"));
  const rolePage = characterPage(map, game, locale);
  const roles = [];
  const ids = new Set<string>();
  for (const [recordId, row] of Object.entries(object(rolePage.records))) {
    signal?.throwIfAborted();
    const role = await readRoleMaterials(data, object(row).path, recordId, game, version);
    if (!role.items.length) continue;
    for (const { id } of role.items) ids.add(id!);
    roles.push(role);
  }
  if (!ids.size) return false;
  const url = `${atlasSourceOrigin}/${game}/${version}/${locale}/item_all.json`;
  const table = object(JSON.parse((await readAtlasSourceBytes(url, "application/json", maxTableBytes, false, signal, request,
    { retry: true }))!.toString("utf8")));
  if (!Object.keys(table).length) throw new Error($t("role-material-source.text_e244c41137"));
  const sources = new Map([...ids].flatMap((id) => {
    const item = materialSource(game, id, table[id]);
    return item ? [[id, item] as const] : [];
  }));
  if (!sources.size) throw new Error($t("role-material-source.text_5d4f7e0d7e"));
  const shared = new Map<string, ReturnType<typeof loadIcon>>();
  const icons = new Map<string, Awaited<ReturnType<typeof loadIcon>>>();
  const wanted = includeArtwork ? [...new Set(roles.flatMap(({ items }) => items.flatMap(({ id, artwork }) => artwork ? [] : [id!])))] : [];
  let processed = 0;
  await reportProgress(onProgress, { stage: "materials", message: $t("role-material-source.text_a7dbd8bb33", { "game": game }), completed: 0, total: wanted.length, unit: $t("role-material-source.text_49ccde43a1") }, signal);
  for (let index = 0; index < wanted.length; index += 6) {
    const results = await Promise.allSettled(wanted.slice(index, index + 6).map(async (id) => {
      for (const name of sources.get(id)?.icons ?? []) {
        if (!shared.has(name)) shared.set(name, loadIcon(root, game, name, request, signal));
        const icon = await shared.get(name);
        if (!icon) continue;
        icons.set(id, icon);
        break;
      }
      await reportProgress(onProgress, { stage: "materials", message: $t("role-material-source.text_3a85508d6f", { "game": game }), completed: ++processed, total: wanted.length, unit: $t("role-material-source.text_49ccde43a1") }, signal);
    }));
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
  let changed = false;
  let applied = 0;
  await reportProgress(onProgress, { stage: "materials-apply", message: $t("role-material-source.text_f84a78ab03", { "game": game }), completed: 0, total: roles.length, unit: $t("role-material-source.text_1aa9c4170b") }, signal);
  for (const { file, raw, items } of roles) {
    const names = Object.fromEntries(items.flatMap(({ id, name: existing }) => {
      const name = existing ? undefined : sources.get(id!)?.name;
      return name ? [[id!, name]] : [];
    }));
    const missing = new Set(items.flatMap(({ id, artwork }) => artwork ? [] : [id!]));
    const images = [...missing].flatMap((id) => {
      const icon = icons.get(id);
      return icon ? [{ ...icon, fieldPath: `derived.material.${id}` }] : [];
    });
    if (!Object.keys(names).length && !images.length) {
      await reportProgress(onProgress, { stage: "materials-apply", message: $t("role-material-source.text_4eae3d3eb6", { "game": game }), completed: ++applied, total: roles.length, unit: $t("role-material-source.text_1aa9c4170b") }, signal);
      continue;
    }
    const record = evidenceObject(parseLegacyJsonEvidence(raw));
    const meta = evidenceObject(record.meta!);
    const additions = evidenceObject(parseLegacyJsonEvidence(JSON.stringify({ materialNames: names, images })));
    const next = { ...record, meta: { ...meta, materialNames: { ...evidenceObject(meta.materialNames ?? null),
      ...evidenceObject(additions.materialNames!) },
      images: [...Array.isArray(meta.images) ? meta.images : [], ...Array.isArray(additions.images) ? additions.images : []] } };
    await writeAtomic(file, serializeLegacyJsonEvidence(next) + "\n", signal);
    changed = true;
    await reportProgress(onProgress, { stage: "materials-apply", message: $t("role-material-source.text_37ac69b6e3", { "game": game }), completed: ++applied, total: roles.length, unit: $t("role-material-source.text_1aa9c4170b") }, signal);
  }
  return changed;
}
