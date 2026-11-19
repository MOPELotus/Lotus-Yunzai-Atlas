import { createHash } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { object } from "./source-values.ts";
import { validateAtlasCandidate, type AtlasCandidatePage } from "./validate-candidate.ts";

const origin = "https://static.nanoka.cc";
const game = "zzz";
const locale = "zh";
const versions = /^(0|[1-9]\d{0,7})(?:\.(?:0|[1-9]\d{0,7})){1,3}(?:\+(?:0|[1-9]\d{0,14}))?$/u;
const bangbooImages = "UI/Sprite/A1DynamicLoad/BangbooModGarage/UnPacker/BangbooRole";
const weaponImages = "Assets/NapResources/UI/Sprite/A1DynamicLoad/ItemIconWeapon/UnPacker";
const bangbooIcon = new RegExp(`^${bangbooImages}/([A-Za-z0-9_-]{1,120})\\.png$`, "u");
const weaponIcon = /^Weapon_[A-Za-z0-9_-]{1,113}$/u;
const pages = {
  bangboo: { title: "Bangboo", folder: "邦布", images: bangbooImages },
  weapon: { title: "Weapon", folder: "音擎", images: weaponImages },
} as const;
type SourcePage = keyof typeof pages;
const maxRecords = 256;
const maxJsonBytes = 1024 * 1024;
const maxIconBytes = 2 * 1024 * 1024;
const requestTimeout = 10_000;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const placeholderPath = "gallery/_placeholder/unknown.svg";
// Keep the owner's legacy placeholder bytes so old and new classifications can share its gallery path.
const placeholder = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-label="Missing image"><rect width="256" height="256" rx="36" fill="#141827"/><path d="M62 176 98 132l29 35 22-27 45 56H62Z" fill="#2b3248"/><circle cx="183" cy="76" r="18" fill="#39435e"/><path d="M128 58c-24 0-42 14-45 36h30c2-8 8-13 16-13 9 0 15 5 15 13 0 7-4 12-15 20-17 12-24 23-23 41h28c0-10 4-16 17-25 16-11 25-23 25-39 0-20-19-33-48-33Z" fill="#b8c0d9"/><circle cx="120" cy="188" r="15" fill="#b8c0d9"/></svg>\n`;

type SourceFetch = (url: string, options: RequestInit) => Promise<Response>;

export interface AtlasAcquiredSource {
  readonly directory: string;
  readonly pages: readonly Required<AtlasCandidatePage>[];
  readonly imageCount: number;
  readonly missingImageCount: number;
}

async function responseBytes(url: string, accept: string, limit: number, optional: boolean,
  signal: AbortSignal, request: SourceFetch): Promise<Buffer | undefined> {
  const response = await request(url, {
    redirect: "error", credentials: "omit", headers: { Accept: accept },
    signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeout)]),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    if (optional && response.status === 404) return;
    throw new Error(`图鉴来源读取失败（HTTP ${response.status}）。`);
  }
  const reader = response.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("图鉴来源文件超出大小上限。");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function sourceJson(url: string, optional: boolean, signal: AbortSignal, request: SourceFetch) {
  const bytes = await responseBytes(url, "application/json", maxJsonBytes, optional, signal, request);
  return bytes === undefined ? undefined : JSON.parse(utf8.decode(bytes)) as unknown;
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { flag: "wx" });
}

function sourceIndex(pageId: SourcePage, value: unknown) {
  const entries = Object.entries(object(value));
  const { folder } = pages[pageId];
  if (entries.length === 0 || entries.length > maxRecords) throw new Error(`${folder}索引条目数无效。`);
  return entries.map(([id, value]) => {
    const list = object(value);
    const { zh, rank, icon, type } = list;
    if (!/^[1-9]\d{0,9}$/u.test(id) || typeof zh !== "string" || !zh.trim() || typeof icon !== "string" ||
        (rank !== 3 && rank !== 4 && !(pageId === "weapon" && rank === 2))) throw new Error(`${folder}来源索引条目结构无效。`);
    if (pageId === "weapon") {
      if (!weaponIcon.test(icon) || typeof type !== "number" || !Number.isInteger(type) || type < 1 || type > 7) {
        throw new Error("音擎来源索引条目结构无效。");
      }
      return { id, list, name: zh.trim(), rank, iconName: icon };
    }
    const iconName = bangbooIcon.exec(icon)?.[1];
    if (icon !== "" && !iconName) throw new Error("邦布来源索引条目结构无效。");
    return { id, list, name: zh.trim(), rank, iconName };
  });
}

function detailMatches(pageId: SourcePage, detail: unknown, entry: ReturnType<typeof sourceIndex>[number]) {
  const { id, name, rank, iconName, list } = entry;
  const item = object(detail);
  if (item.id !== Number(id) || typeof item.name !== "string" || item.name.trim() !== name || item.rarity !== rank) return false;
  if (pageId === "bangboo") return true;
  const types = Object.keys(object(item.weapon_type));
  return item.code_name === iconName && item.icon === `${weaponImages}/${iconName}.png` &&
    types.length === 1 && types[0] === String(list.type);
}

function webp(bytes: Buffer): boolean {
  return bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.readUInt32LE(4) === bytes.length - 8 &&
    bytes.toString("ascii", 8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16)) &&
    bytes.readUInt32LE(16) <= bytes.length - 20;
}

async function readIcon(name: string, pageId: SourcePage, target: string, signal: AbortSignal, request: SourceFetch) {
  const localPath = `gallery/${game}/${name}.webp`;
  for (const path of [name, `${pages[pageId].images}/${name}`]) {
    const remoteUrl = `${origin}/assets/${game}/${path}.webp`;
    const bytes = await responseBytes(remoteUrl, "image/webp", maxIconBytes, true, signal, request);
    if (!bytes) continue;
    if (!webp(bytes)) throw new Error(`${pages[pageId].folder}来源图标不是有效的 WebP 文件。`);
    await mkdir(join(target, "gallery", game), { recursive: true });
    await writeFile(join(target, localPath), bytes, { flag: "wx" });
    return { remoteUrl, localPath, sha256: createHash("sha256").update(bytes).digest("hex"),
      contentType: "image/webp", bytes: bytes.length };
  }
}

/** Fetch a complete verified page into a fresh source root suitable for candidate assembly. */
export async function acquireAtlasSource(destination: string, requirements: readonly AtlasCandidatePage[],
  signal?: AbortSignal, request: SourceFetch = fetch): Promise<AtlasAcquiredSource> {
  const scope = requirements[0];
  if (requirements.length !== 1 || scope?.game !== game || (scope.pageId !== "bangboo" && scope.pageId !== "weapon") ||
      typeof scope.version !== "string" || !versions.test(scope.version)) {
    throw new Error("当前只支持按指定版本抓取绝区零邦布或音擎分类。");
  }
  const { pageId, version } = scope;
  const { folder, title } = pages[pageId];
  const timeout = AbortSignal.timeout(180_000);
  const active = signal ? AbortSignal.any([signal, timeout]) : timeout;
  active.throwIfAborted();
  const resolved = resolve(destination);
  const target = join(await realpath(dirname(resolved)), basename(resolved));
  const data = join(target, "data");
  const items = `items/${locale}/${game}/${pageId}`;
  await mkdir(target, { mode: 0o700 });
  try {
    const sourcePath = `${version}/${pageId}.json`;
    const sourceUrl = `${origin}/${game}/${sourcePath}`;
    const entries = sourceIndex(pageId, await sourceJson(sourceUrl, false, active, request));
    if (scope.recordCount !== undefined && entries.length !== scope.recordCount) throw new Error(`${folder}来源条目数与计划不符。`);
    await mkdir(join(data, items), { recursive: true });
    const records: Record<string, unknown> = {};
    const images = new Map<string, Awaited<ReturnType<typeof readIcon>>>();
    let usedPlaceholder = false;
    for (const entry of entries) {
      const { id, name, rank, iconName, list } = entry;
      const detailUrl = `${origin}/${game}/${version}/${locale}/${pageId}/${id}.json`;
      const detail = await sourceJson(detailUrl, pageId === "bangboo", active, request);
      if (detail !== undefined && !detailMatches(pageId, detail, entry)) {
        throw new Error(`${folder}详情与来源索引身份或等级不符（${id}）。`);
      }
      const hasDetail = detail !== undefined;
      const detailSourceUrl = hasDetail ? detailUrl : null;
      const references = [];
      if (iconName) {
        if (!images.has(iconName)) images.set(iconName, await readIcon(iconName, pageId, target, active, request));
        const icon = images.get(iconName);
        if (!icon && pageId === "weapon") throw new Error(`音擎来源图标缺失（${id}）。`);
        references.push({ fieldPath: "icon", originalValue: list.icon, ...(icon
          ? { ...icon, status: "downloaded", placeholder: false }
          : { status: "placeholder", placeholder: true, placeholderReason: "remote_missing", remoteUrl: null,
            localPath: placeholderPath, contentType: "image/svg+xml", bytes: Buffer.byteLength(placeholder),
            sha256: createHash("sha256").update(placeholder).digest("hex") }) });
        usedPlaceholder ||= !icon;
        const detailIcon = object(detail).icon;
        if (typeof detailIcon === "string" && (pageId === "weapon" || detailIcon === list.icon)) {
          references.push({ ...references[0], fieldPath: "detail.icon", originalValue: detailIcon });
        }
      }
      const path = `${items}/${id}.json`;
      const rarity = rank === 4 ? "S级" : rank === 3 ? "A级" : "B级";
      const metadata = { sourceUrl, sourcePath, sourceLocale: null, localeMode: "embedded", detailSourceUrl };
      await writeJson(join(data, path), { meta: { ...metadata, gameId: game, pageId, locale,
        recordId: id, name, version, rarity, hasDetail, images: references }, content: { list, detail: detail ?? null } });
      records[id] = { id, name, rarity, path, hasDetail, detailSourceUrl, imageCount: references.length };
    }
    if (usedPlaceholder) {
      await mkdir(join(target, "gallery", "_placeholder"), { recursive: true });
      await writeFile(join(target, placeholderPath), placeholder, { flag: "wx" });
    }
    const page = { id: pageId, title, folder, sourceUrl, sourcePath, sourceLocale: null,
      localeMode: "embedded", version, recordCount: entries.length, totalRecordCount: entries.length, sampled: false, records };
    await writeJson(join(data, "map.json"), {
      meta: { source: "https://nanoka.cc/", locales: [locale], imageDownloads: true,
        requestedVersions: { [game]: version }, selectedPages: { [game]: [pageId] } },
      games: { [game]: { game: { id: game, versions: [version], requestedVersion: version },
        locales: { [locale]: { pages: { [pageId]: page } } } } },
    });
    const validation = await validateAtlasCandidate(data, requirements, active);
    if (!validation.ok) throw new Error(`抓取的源快照未通过校验。${validation.issues[0] ?? ""}`);
    const missingImageCount = [...images.values()].filter((image) => image === undefined).length;
    return { directory: target, pages: validation.pages, imageCount: images.size - missingImageCount, missingImageCount };
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}
