import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { reportAtlasInitializationProgress as reportProgress, type AtlasInitializationProgressCallback } from "./initialization-progress.ts";
import { atlasLocales, defaultAtlasLocale, type AtlasLocale } from "./locale.ts";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { candidateFile, copyCandidateFile, type CandidateImageRecovery } from "./candidate-gallery.ts";
import { isAtlasSourceWebp, readAtlasSourceBytes, type AtlasSourceFetch } from "./source-transport.ts";
import { validateAtlasCandidate } from "./validate-candidate.ts";
import { atlasSourcePlaceholder } from "./source-acquisition.ts";
import { object } from "./source-values.ts";
import { parseLegacyJsonEvidence, serializeLegacyJsonEvidence } from "./legacy-json-evidence.ts";
import { nativeAtlasAssetMetadata, nativeAtlasAssetUrl, nativeAtlasGameNames, nativeAtlasPageOrigin, readNativeAtlasRecord, type NativeAtlasPage } from "./native-record-export.ts";

interface NativeAtlasIndex extends NativeAtlasPage {
  readonly recordCount: number;
  readonly rows: ReadonlyMap<string, string>;
}

interface NativeExportOptions {
  readonly destination: string;
  readonly cache: string;
  readonly indexes: readonly NativeAtlasIndex[];
  readonly sourceRoots: readonly string[];
  readonly refreshDetails?: boolean;
  readonly request?: AtlasSourceFetch;
  readonly signal?: AbortSignal;
  readonly onProgress?: AtlasInitializationProgressCallback;
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const maxNativeImageBytes = 12 * 1024 * 1024;
const recordId = /^[a-z0-9_-]{1,80}$/iu;
const missingFile = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

async function atomic(path: string, bytes: string | Buffer) {
  await mkdir(dirname(path), { recursive: true });
  const stage = await mkdtemp(join(dirname(path), ".write-"));
  try {
    const temp = join(stage, "data");
    await Bun.write(temp, bytes);
    await rename(temp, path);
  } finally { await rm(stage, { recursive: true, force: true }); }
}

async function readFileIfExists(path: string) {
  try {
    if (!(await lstat(path)).isFile()) throw new Error($t("native-atlas-export.text_5ede3d0b52"));
    return await readFile(path);
  } catch (error) {
    if (!missingFile(error)) throw error;
  }
}

async function digestCache(root: string, url: string, make: () => Promise<Buffer | undefined>,
  valid: (bytes: Buffer) => boolean) {
  const key = sha256(url);
  const base = join(root, key.slice(0, 2), key);
  const parent = dirname(base);
  await mkdir(parent, { recursive: true });
  if (await realpath(parent) !== parent) throw new Error($t("native-atlas-export.text_ffef18dfb7"));
  const expected = (await readFileIfExists(base + ".sha256"))?.toString("utf8");
  if (expected) {
    const bytes = await readFileIfExists(base);
    if (bytes && sha256(bytes) === expected && valid(bytes)) return bytes;
  }
  const bytes = await make();
  if (!bytes) return;
  if (!valid(bytes)) throw new Error($t("native-atlas-export.text_c5dd96efcb"));
  await atomic(base, bytes);
  await atomic(base + ".sha256", sha256(bytes));
  return bytes;
}

/** Repair a reused file in the candidate only, preserving the previously accepted bytes. */
export function nativeAtlasImageRecovery(cache: string, sourceRoots: readonly string[],
  request: AtlasSourceFetch = fetch): CandidateImageRecovery {
  const placeholder = Buffer.from(atlasSourcePlaceholder);
  return {
    placeholderSha256: sha256(placeholder),
    async read(source, game, reference, path, expected, signal) {
      if (reference.placeholder === true) return placeholder;
      const valid = (bytes: Buffer) => isAtlasSourceWebp(bytes) && sha256(bytes) === expected;
      for (const donor of sourceRoots) {
        if (donor === source) continue;
        signal?.throwIfAborted();
        const file = await candidateFile(donor, path).catch(() => undefined);
        if (!file || Bun.file(file).size > maxNativeImageBytes) continue;
        const bytes = await readFile(file);
        if (valid(bytes)) return bytes;
      }
      const remote = reference.remoteUrl ?? reference.url;
      if (typeof remote !== "string") return;
      const url = nativeAtlasAssetUrl(game, remote).href;
      return digestCache(join(cache, "images"), url,
        () => readAtlasSourceBytes(url, "image/webp", maxNativeImageBytes, true, signal, request, { retry: true }), valid);
    },
  };
}

type SeedImage = { readonly root: string; readonly path: string; readonly sha256: string };

async function imageSeeds(roots: readonly string[], signal?: AbortSignal) {
  const found = new Map<string, SeedImage[]>();
  for (const root of roots) {
    const data = join(root, "data");
    const map = object(await Bun.file(await candidateFile(data, "map.json")).json());
    for (const game of Object.values(object(map.games))) {
      for (const locale of Object.values(object(object(game).locales))) {
        for (const page of Object.values(object(object(locale).pages))) {
          for (const record of Object.values(object(object(page).records))) {
            signal?.throwIfAborted();
            const path = object(record).path;
            if (typeof path !== "string" || !path.startsWith("items/")) continue;
            const file = await candidateFile(data, path);
            const { images } = object(object(await Bun.file(file).json()).meta);
            for (const row of Array.isArray(images) ? images : []) {
              const { status, remoteUrl, localPath, sha256 } = object(row);
              if (status !== "downloaded" || typeof remoteUrl !== "string" || typeof localPath !== "string" ||
                  typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256)) continue;
              const entries = found.get(remoteUrl) ?? [];
              if (!entries.some(entry => entry.root === root && entry.path === localPath && entry.sha256 === sha256)) {
                entries.push({ root, path: localPath, sha256 });
                found.set(remoteUrl, entries);
              }
            }
          }
        }
      }
    }
  }
  return found;
}

type GameFolder = {
  game: { id: string; name: string; folder: string; versions: readonly string[]; requestedVersion: string | null };
  locales: Partial<Record<AtlasLocale, { id: AtlasLocale; label: string; folder: string; pages: Record<string, unknown> }>>;
};

/** Stages original indexes, details and artwork from Nanoka using Bun only. */
export async function nativeAtlasExport({ destination, cache, indexes, sourceRoots, refreshDetails,
  request = fetch, signal, onProgress }: NativeExportOptions) {
  if (!indexes.length || new Set(indexes.map(({ game, pageId, locale = defaultAtlasLocale }) => `${game}/${locale}/${pageId}`)).size !== indexes.length) {
    throw new Error($t("native-atlas-export.text_91bdf9f289"));
  }
  await mkdir(destination, { mode: 0o700 });
  const data = join(destination, "data");
  await mkdir(data, { mode: 0o700 });
  const games: Record<string, GameFolder> = {};
  const locales = new Set<AtlasLocale>();
  const assets = new Map<string, Promise<ReturnType<typeof nativeAtlasAssetMetadata> | undefined>>();
  await reportProgress(onProgress, { stage: "cache", message: $t("native-atlas-export.text_2de581cec9") }, signal);
  const seeds = await imageSeeds(sourceRoots, signal);
  let completedRecords = 0, completedImages = 0;
  const totalRecords = indexes.reduce((sum, page) => sum + page.recordCount, 0);
  for (const page of indexes) {
    signal?.throwIfAborted();
    const { game, pageId, version, rows, locale = defaultAtlasLocale } = page;
    const language = atlasLocales[locale];
    locales.add(locale);
    if (rows.size !== page.recordCount) throw new Error($t("native-atlas-export.text_09b7101a65"));
    const origin = nativeAtlasPageOrigin(page);
    const records: Record<string, unknown> = Object.create(null);
    const input = [...rows];
    const progress = () => reportProgress(onProgress, { stage: "download", message: $t("native-atlas-export.text_ea255c4f36", { "game": nativeAtlasGameNames[game].game, "pageId": pageId, "completedImages": completedImages }),
      completed: completedRecords, total: totalRecords, unit: $t("native-atlas-export.text_f004f1d84c") }, signal);
    await progress();
    const indexHash = sha256(JSON.stringify(input));
    const details: AtlasSourceFetch = refreshDetails ? request : async (url, init) => {
      const bytes = await digestCache(join(cache, "details"), url + "#" + indexHash,
        () => readAtlasSourceBytes(url, "application/json", 8 * 1024 * 1024, true, init.signal ?? signal, request, { retry: true }),
        value => { try { return !!JSON.parse(value.toString("utf8")); } catch { return false; } });
      return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
    };
    async function image(url: string) {
      let pending = assets.get(url);
      if (!pending) {
        pending = (async () => {
          for (const seed of seeds.get(url) ?? []) {
            const file = await candidateFile(seed.root, seed.path).catch(() => undefined);
            if (!file || Bun.file(file).size > maxNativeImageBytes) continue;
            const bytes = await readFile(file);
            if (!isAtlasSourceWebp(bytes) || sha256(bytes) !== seed.sha256) continue;
            const meta = nativeAtlasAssetMetadata(game, url, bytes);
            await copyCandidateFile(file, join(destination, meta.localPath));
            return meta;
          }
          const bytes = await digestCache(join(cache, "images"), url,
            () => readAtlasSourceBytes(url, "image/webp", maxNativeImageBytes, true, signal, request, { retry: true }),
            isAtlasSourceWebp);
          if (!bytes) return;
          const meta = nativeAtlasAssetMetadata(game, url, bytes);
          await atomic(join(destination, meta.localPath), bytes);
          return meta;
        })().then(async result => {
          completedImages++;
          await progress();
          return result;
        });
        assets.set(url, pending);
      }
      return pending;
    }
    const base = join(data, "items", language.folder, game, pageId);
    await mkdir(base, { recursive: true });
    for (let offset = 0; offset < input.length; offset += 6) {
      const group = await Promise.allSettled(input.slice(offset, offset + 6).map(async ([id, list]) => {
        if (!recordId.test(id)) throw new Error($t("native-atlas-export.text_9f9a32e6c8"));
        const record = await readNativeAtlasRecord(page, id, JSON.parse(list), image, signal, details);
        const path = `items/${language.folder}/${game}/${pageId}/${id}.json`;
        const exact = { meta: parseLegacyJsonEvidence(JSON.stringify(record.meta)), content: {
          list: parseLegacyJsonEvidence(list), detail: parseLegacyJsonEvidence(record.detailSource),
        } };
        await Bun.write(join(data, path), serializeLegacyJsonEvidence(exact) + "\n");
        completedRecords++;
        await progress();
        return { record, path };
      }));
      const failed = group.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
      for (const result of group) {
        if (result.status !== "fulfilled") continue;
        const { record, path } = result.value;
        const { recordId: id, name, rarity, hasDetail, detailSourceUrl, images } = record.meta;
        records[id] = { id, name, rarity, hasDetail, detailSourceUrl, path, imageCount: images.length };
      }
    }
    const identity = nativeAtlasGameNames[game];
    const target = games[game] ??= {
      game: { id: game, name: identity.game, folder: identity.folder, versions: [version], requestedVersion: version },
      locales: {},
    };
    if (target.game.requestedVersion !== version) throw new Error($t("native-atlas-export.text_61c701da05"));
    const localized = target.locales[locale] ??= { id: locale, ...language, pages: {} };
    localized.pages[pageId] = { id: pageId, ...origin, version,
      recordCount: rows.size, totalRecordCount: rows.size, sampled: false, records };
  }
  await atomic(join(destination, "gallery", "_placeholder", "unknown.svg"), atlasSourcePlaceholder);
  await Bun.write(join(data, "map.json"), JSON.stringify({ meta: { source: "https://nanoka.cc/", locales: [...locales] }, games }) + "\n");
  await reportProgress(onProgress, { stage: "validate", message: $t("native-atlas-export.text_4f7683d5ac") }, signal);
  const validation = await validateAtlasCandidate(data, indexes, signal);
  if (!validation.ok) throw new Error($t("native-atlas-export.text_01ca88f080", { "value1": validation.issues[0] ?? "" }));
  return validation;
}
