import { Database } from "bun:sqlite";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { candidateFile, candidateImageReference, hashCandidateFile } from "./candidate-gallery.ts";
import type { Game } from "./catalog.ts";
import { assembleAtlasCandidate, copyAtlasSelectedPages } from "./assemble-candidate.ts";
import { nativeAtlasExport, nativeAtlasImageRecovery } from "./native-atlas-export.ts";
import { evidenceObject, parseLegacyJsonEvidence, serializeLegacyJsonEvidence } from "./legacy-json-evidence.ts";
import { legacyAtlasSourcePages } from "./legacy-source-profile.ts";
import { atlasSourceOrigin, readAtlasSourceBytes, type AtlasSourceFetch } from "./source-transport.ts";
import { object } from "./source-values.ts";
import { type AtlasCandidatePage, validateAtlasCandidate } from "./validate-candidate.ts";

const atlasVersion = /^(0|[1-9]\d{0,7})(?:\.(?:0|[1-9]\d{0,7})){1,3}(?:\+(?:0|[1-9]\d{0,14}))?$/u;
const maxExportIndexBytes = 16 * 1024 * 1024;

export type AtlasExportVersions = Readonly<Partial<Record<Game, string>>>;
export type AtlasExportPageSelection = Readonly<Pick<AtlasCandidatePage, "game" | "pageId">>;
type ExportPage = Required<AtlasCandidatePage>;
export type AtlasSourceIndex = ExportPage & { readonly rows: ReadonlyMap<string, string> };
type ExportScope = ExportPage & { readonly rows?: AtlasSourceIndex["rows"] };

function selectedExporterPages(versions: AtlasExportVersions, scope?: readonly AtlasExportPageSelection[]) {
  let profiles = legacyAtlasSourcePages;
  if (scope !== undefined) {
    const keys = new Set(scope.map(({ game, pageId }) => `${game}/${pageId}`));
    profiles = profiles.filter(({ game, pageId }) => keys.has(`${game}/${pageId}`));
    if (!scope.length || keys.size !== scope.length || profiles.length !== keys.size) {
      throw new Error("请选择已识别且不重复的图鉴分类。");
    }
  }
  return profiles.map(({ game, pageId, indexPath, indexShape }) => {
    const version = versions[game];
    if (typeof version !== "string" || !atlasVersion.test(version) || (game !== "zzz" && version.includes("+"))) {
      throw new Error(`请选择图鉴原站提供的 ${game} 版本。`);
    }
    return { game, pageId, version, indexShape, indexPath: `/${game}/${version}/${indexPath.split("/").slice(3).join("/")}` };
  });
}

export async function readSelectedExporterIndexes(versions: AtlasExportVersions, signal?: AbortSignal,
  request: AtlasSourceFetch = fetch, scope?: readonly AtlasExportPageSelection[]): Promise<readonly AtlasSourceIndex[]> {
  const selected = selectedExporterPages(versions, scope);
  const indexes: AtlasSourceIndex[] = [];
  for (let start = 0; start < selected.length; start += 4) {
    const batch = await Promise.all(selected.slice(start, start + 4).map(async ({ game, pageId, version, indexPath, indexShape }) => {
      const bytes = await readAtlasSourceBytes(`${atlasSourceOrigin}${indexPath}`, "application/json",
        maxExportIndexBytes, false, signal, request, { retry: true });
      const value = parseLegacyJsonEvidence(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      const listing = indexShape === "array" && Array.isArray(value) ? value : evidenceObject(value);
      const entries = Object.entries(listing);
      if ((indexShape === "array" && !Array.isArray(listing)) || !entries.length ||
          entries.some(([, row]) => row !== evidenceObject(row))) throw new Error(`${game}/${pageId} 原站索引结构无效。`);
      return { game, pageId, version, recordCount: entries.length,
        rows: new Map(entries.map(([id, row]) => [id, serializeLegacyJsonEvidence(row)])) };
    }));
    indexes.push(...batch);
  }
  return indexes;
}

function contains(parent: string, child: string) {
  const location = relative(parent, child);
  return !isAbsolute(location) && location.split(sep)[0] !== "..";
}

async function entry(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
  }
}

async function acquireWorkspace(path: string, target: string) {
  const resolved = resolve(path);
  const workspace = join(await realpath(dirname(resolved)), basename(resolved));
  if (contains(target, workspace) || contains(workspace, target)) {
    throw new Error("公网图鉴下载工作目录必须独立于发布目录。");
  }
  const existing = await entry(workspace);
  if (existing && !existing.isDirectory()) throw new Error("图鉴下载工作目录须为实体目录。");
  if (!existing) await mkdir(workspace, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (await realpath(workspace) !== workspace) throw new Error("图鉴下载工作目录须为实体目录。");
  return workspace;
}

async function verifyExporterOutput(directory: string, signal?: AbortSignal) {
  const root = await entry(directory);
  if (!root) return;
  if (!root.isDirectory()) throw new Error("图鉴下载数据须位于工作区实体目录内。");
  const pending = [directory];
  while (pending.length) {
    const parent = pending.pop()!;
    for (const name of await readdir(parent)) {
      signal?.throwIfAborted();
      const path = join(parent, name);
      const metadata = await lstat(path);
      if (metadata.isDirectory()) pending.push(path);
      else if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("图鉴下载数据不能包含链接或特殊文件。");
    }
  }
}

async function matchesExportIndex(directory: string, map: Record<string, unknown>, { game, pageId, rows }: ExportScope,
  signal?: AbortSignal): Promise<boolean> {
  if (!rows) return true;
  const gameData = object(object(map.games)[game]);
  const localized = object(object(gameData.locales).zh);
  const records = object(object(object(localized.pages)[pageId]).records);
  for (const [id, row] of rows) {
    signal?.throwIfAborted();
    const { path } = object(records[id]);
    if (typeof path !== "string" || !path.startsWith("items/")) return false;
    const file = await candidateFile(directory, path);
    const item = evidenceObject(parseLegacyJsonEvidence(await Bun.file(file).text()));
    const list = evidenceObject(item.content ?? null).list;
    if (list === undefined || serializeLegacyJsonEvidence(list) !== row) return false;
  }
  return true;
}

export async function changedAtlasSourceIndexes(directory: string, indexes: readonly AtlasSourceIndex[], signal?: AbortSignal) {
  const map = object(await Bun.file(await candidateFile(directory, "map.json")).json());
  const changed: AtlasSourceIndex[] = [];
  for (const index of indexes) {
    const { game, pageId, version, rows, recordCount } = index;
    signal?.throwIfAborted();
    const gameData = object(object(map.games)[game]);
    const locale = object(object(gameData.locales).zh);
    const page = object(object(locale.pages)[pageId]);
    if (page.version === version) {
      const missing = Object.keys(object(page.records)).find(id => !rows.has(id));
      if (missing) throw new Error(`${game}/${pageId} 同版索引缺少现用条目 ${missing}。`);
      if (page.recordCount === recordCount && await matchesExportIndex(directory, map, { game, pageId, version, recordCount, rows }, signal)) {
        continue;
      }
    }
    changed.push(index);
  }
  return changed;
}

export async function inspectExporterPages(root: string, signal?: AbortSignal, scope: readonly ExportScope[] = legacyAtlasSourcePages) {
  const data = join(root, "data");
  await verifyExporterOutput(data, signal);
  await verifyExporterOutput(join(root, "gallery"), signal);
  const gallery = await Bun.file(join(data, "gallery-index.json")).json().catch(() => undefined);
  const references = object(gallery).images;
  const completed = new Set<string>();
  const corruptImages = new Set<string>();
  if (!Array.isArray(references)) return { completed, corruptImages, exactScope: false };
  const { pages, ok } = await validateAtlasCandidate(data, [], signal);
  const profiles = new Map(scope.map((page) => [`${page.game}/${page.pageId}`, page]));
  const map = scope.some(({ rows }) => rows) ? object(await Bun.file(join(data, "map.json")).json().catch(() => undefined)) : {};
  const images = new Map<string, { file: string; sha256: string } | null>();
  for (const { game, pageId, version, recordCount } of pages) {
    const key = `${game}/${pageId}`;
    const expected = profiles.get(key);
    if (expected?.version === version && expected.recordCount === recordCount &&
        await matchesExportIndex(data, map, expected, signal)) completed.add(key);
  }
  let placeholderRepairPage: string | undefined;
  // The original exporter also flags confirmed placeholders for future refreshes.
  for (const row of references) {
    signal?.throwIfAborted();
    const image = object(row);
    const { gameId, pageId, status, retryable, placeholderReason } = image;
    const key = `${gameId}/${pageId}`;
    const profile = profiles.get(key);
    if (!profile) continue;
    const acceptedPlaceholder = status === "placeholder" && retryable === false &&
      (placeholderReason === "remote_missing" || placeholderReason === "no_candidates");
    let asset;
    try {
      asset = candidateImageReference(image, profile.game);
    } catch {
      // The exporter will recreate invalid per-image metadata when it refreshes the page.
    }
    if (!asset || (status !== "downloaded" && !acceptedPlaceholder)) {
      completed.delete(key);
      continue;
    }
    if (!images.has(asset.path)) {
      const file = await candidateFile(root, asset.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      images.set(asset.path, file ? { file, sha256: await hashCandidateFile(file, signal) } : null);
    }
    const actual = images.get(asset.path);
    if (acceptedPlaceholder) {
      if (actual?.sha256 !== image.sha256) placeholderRepairPage ??= key;
    } else if (!actual || actual.sha256 !== asset.sha256) {
      completed.delete(key);
      if (actual) corruptImages.add(actual.file);
    }
  }
  // Any exporter invocation rewrites the shared placeholder.
  if (placeholderRepairPage && completed.size === profiles.size) completed.delete(placeholderRepairPage);
  return { completed, corruptImages, exactScope: ok && pages.length === scope.length };
}

async function downloadAtlasExport<T>(path: string, target: string, selected: () => Promise<readonly AtlasSourceIndex[]>,
  consume: (source: string, pages: readonly ExportPage[]) => Promise<T>, signal?: AbortSignal,
  publishedBaseline?: string, request?: AtlasSourceFetch): Promise<T> {
  signal?.throwIfAborted();
  const workspace = await acquireWorkspace(path, await realpath(target));
  const lockFile = join(workspace, ".download.sqlite");
  const lockPath = await entry(lockFile);
  if (lockPath && !lockPath.isFile()) throw new Error("图鉴下载锁须为实体文件。");
  const lock = new Database(lockFile);
  let stage: string | undefined;
  try {
    lock.exec("PRAGMA busy_timeout = 0");
    try {
      lock.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code?.startsWith("SQLITE_BUSY")) {
        throw new Error("该工作目录已有公网图鉴下载正在进行。");
      }
      throw error;
    }
    const indexes = await selected();
    const pages = indexes.map(({ game, pageId, version, recordCount }) => ({ game, pageId, version, recordCount }));
    const legacy = join(workspace, "backend");
    const sources = [];
    if (publishedBaseline && (await validateAtlasCandidate(publishedBaseline, [], signal)).ok) {
      sources.push(dirname(publishedBaseline));
    }
    if ((await entry(legacy))?.isDirectory() && (await entry(join(legacy, "data")))?.isDirectory() &&
        (await validateAtlasCandidate(join(legacy, "data"), [], signal)).ok) sources.push(legacy);

    const cache = join(workspace, "native-cache");
    await mkdir(cache, { recursive: true, mode: 0o700 });
    if (!(await entry(cache))?.isDirectory() || await realpath(cache) !== cache) {
      throw new Error("图鉴原资源缓存须为实体目录。");
    }
    for (const item of await readdir(workspace, { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (item.isDirectory() && /^\.native-atlas-build-[A-Za-z0-9]{6}$/u.test(item.name)) {
        await rm(join(workspace, item.name), { recursive: true, force: true });
      }
    }
    stage = await mkdtemp(join(workspace, ".native-atlas-build-"));
    let remaining = indexes;
    const reusable = [];
    for (const seed of sources) {
      const data = join(seed, "data");
      const changed = await changedAtlasSourceIndexes(data, remaining, signal).catch((error: unknown) => {
        if (data === publishedBaseline) throw error;
        signal?.throwIfAborted();
        return remaining;
      });
      const ready = remaining.filter(page => !changed.includes(page));
      if (ready.length) reusable.push({ seed, pages: ready });
      remaining = changed;
    }

    let source: string | undefined;
    if (remaining.length) {
      source = join(stage, "original");
      await nativeAtlasExport({ destination: source, cache, indexes: remaining, sourceRoots: sources, request, signal });
    }
    const recovery = nativeAtlasImageRecovery(cache, sources, request);
    for (const [index, donor] of reusable.entries()) {
      const destination = join(stage, `merge-${index}`);
      const combined = source ? await assembleAtlasCandidate(source, donor.seed, destination, donor.pages, signal, recovery)
        : await copyAtlasSelectedPages(donor.seed, destination, donor.pages, signal, recovery);
      source = combined.directory;
    }
    if (!source) throw new Error("未选中图鉴下载分类。");
    const roles = indexes.find(({ game, pageId }) => game === "gi" && pageId === "character");
    if (roles) {
      const { completeGenshinPortraits } = await import("./genshin-original-portraits.ts");
      await completeGenshinPortraits(source, roles.version, signal, request);
    }
    if (indexes.some(({ pageId }) => pageId === "character")) {
      const { completeAtlasRoleMaterials } = await import("./role-material-source.ts");
      await completeAtlasRoleMaterials(source, pages, signal, request);
    }
    const validated = await validateAtlasCandidate(join(source, "data"), pages, signal);
    if (!validated.ok) throw new Error(`公网图鉴候选未通过校验。${validated.issues[0] ?? ""}`);
    return await consume(source, pages);
  } finally {
    try { if (stage) await rm(stage, { recursive: true, force: true }); }
    finally { lock.close(); }
  }
}

/** Read the prior pinned public versions and retain the audited per-page counts. */
export function downloadLegacyAtlas<T>(path: string, target: string, consume: (source: string) => Promise<T>,
  signal?: AbortSignal): Promise<T> {
  const versions = Object.fromEntries(legacyAtlasSourcePages.map(({ game, version }) => [game, version]));
  return downloadAtlasExport(path, target, async () => {
    const indexes = await readSelectedExporterIndexes(versions, signal);
    if (indexes.some(({ recordCount }, index) => recordCount !== legacyAtlasSourcePages[index]?.recordCount)) {
      throw new Error("原站固定版本图鉴分类或条目数与旧资料记录不符。");
    }
    return indexes;
  }, consume, signal);
}

/** Run all supported pages at the versions already selected from the original website manifest. */
export function downloadAtlasVersion<T>(path: string, target: string, versions: AtlasExportVersions,
  consume: (source: string, pages: readonly ExportPage[]) => Promise<T>, signal?: AbortSignal,
  request?: AtlasSourceFetch, scope?: readonly AtlasExportPageSelection[], publishedBaseline?: string): Promise<T> {
  return downloadAtlasExport(path, target, () => readSelectedExporterIndexes(versions, signal, request, scope), consume, signal,
    publishedBaseline, request);
}

/** Use the same checked source indexes for discovery and for the downloaded candidate. */
export function downloadAtlasVersionFromIndexes<T>(path: string, target: string, indexes: readonly AtlasSourceIndex[],
  consume: (source: string, pages: readonly ExportPage[]) => Promise<T>, signal?: AbortSignal,
  publishedBaseline?: string, request?: AtlasSourceFetch): Promise<T> {
  return downloadAtlasExport(path, target, async () => indexes, consume, signal, publishedBaseline, request);
}
