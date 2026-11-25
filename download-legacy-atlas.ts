import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { reportAtlasInitializationProgress as reportProgress, type AtlasInitializationProgressCallback } from "./initialization-progress.ts";
import { atlasLocaleBlock, atlasPageKey, defaultAtlasLocale, parseAtlasLocale } from "./locale.ts";
import { nativeAtlasPageOrigin } from "./native-record-export.ts";
import type { ValidatedAtlasCandidatePage } from "./validate-candidate.ts";
import { Database } from "bun:sqlite";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { candidateFile, candidateImageReference, hashCandidateFile } from "./candidate-gallery.ts";
import type { Game } from "./catalog.ts";
import { assembleAtlasCandidate, copyAtlasSelectedPages } from "./assemble-candidate.ts";
import { nativeAtlasExport, nativeAtlasImageRecovery } from "./native-atlas-export.ts";
import { evidenceObject, parseLegacyJsonEvidence, serializeLegacyJsonEvidence } from "./legacy-json-evidence.ts";
import { legacyAtlasSourcePages } from "./legacy-source-profile.ts";
import { readAtlasSourceBytes, type AtlasSourceFetch } from "./source-transport.ts";
import { object } from "./source-values.ts";
import { type AtlasCandidatePage, validateAtlasCandidate } from "./validate-candidate.ts";

const atlasVersion = /^(0|[1-9]\d{0,7})(?:\.(?:0|[1-9]\d{0,7})){1,3}(?:\+(?:0|[1-9]\d{0,14}))?$/u;
const maxExportIndexBytes = 16 * 1024 * 1024;

export type AtlasExportVersions = Readonly<Partial<Record<Game, string>>>;
export type AtlasExportPageSelection = Readonly<Pick<AtlasCandidatePage, "game" | "pageId">>;
type ExportPage = ValidatedAtlasCandidatePage;
export type AtlasSourceIndex = ExportPage & { readonly rows: ReadonlyMap<string, string> };
type ExportScope = ExportPage & { readonly rows?: AtlasSourceIndex["rows"] };

function selectedExporterPages(versions: AtlasExportVersions, scope?: readonly AtlasExportPageSelection[], locale = defaultAtlasLocale) {
  let profiles = legacyAtlasSourcePages;
  if (scope !== undefined) {
    const keys = new Set(scope.map(({ game, pageId }) => `${game}/${pageId}`));
    profiles = profiles.filter(({ game, pageId }) => keys.has(`${game}/${pageId}`));
    if (!scope.length || keys.size !== scope.length || profiles.length !== keys.size) {
      throw new Error($t("download-legacy-atlas.text_9d4c31335c"));
    }
  }
  return profiles.map(({ game, pageId, indexShape }) => {
    const version = versions[game];
    if (typeof version !== "string" || !atlasVersion.test(version) || (game !== "zzz" && version.includes("+"))) {
      throw new Error($t("download-legacy-atlas.text_3df9d389f2", { "game": game }));
    }
    return { game, pageId, version, locale, indexShape, indexUrl: nativeAtlasPageOrigin({ game, pageId, version, locale }).sourceUrl };
  });
}

export async function readSelectedExporterIndexes(versions: AtlasExportVersions, signal?: AbortSignal,
  request: AtlasSourceFetch = fetch, scope?: readonly AtlasExportPageSelection[], locale = defaultAtlasLocale,
  onProgress?: AtlasInitializationProgressCallback): Promise<readonly AtlasSourceIndex[]> {
  if (locale === "cht") throw new Error($t("download-legacy-atlas.text_b64465cf72"));
  const selected = selectedExporterPages(versions, scope, locale);
  const indexes: AtlasSourceIndex[] = [];
  let completedIndexes = 0;
  await reportProgress(onProgress, { stage: "indexes", message: $t("download-legacy-atlas.text_684cdc373a"), completed: 0, total: selected.length, unit: $t("download-legacy-atlas.text_4fb249b9d7") }, signal);
  for (let start = 0; start < selected.length; start += 4) {
    const batch = await Promise.all(selected.slice(start, start + 4).map(async ({ game, pageId, version, indexUrl, indexShape }) => {
      const bytes = await readAtlasSourceBytes(indexUrl, "application/json",
        maxExportIndexBytes, false, signal, request, { retry: true });
      const value = parseLegacyJsonEvidence(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      const listing = indexShape === "array" && Array.isArray(value) ? value : evidenceObject(value);
      const entries = Object.entries(listing);
      if ((indexShape === "array" && !Array.isArray(listing)) || !entries.length ||
          entries.some(([, row]) => row !== evidenceObject(row))) throw new Error($t("download-legacy-atlas.text_6bd0054d35", { "game": game, "pageId": pageId }));
      await reportProgress(onProgress, { stage: "indexes", message: $t("download-legacy-atlas.text_f5e34cb3d5", { "game": game, "pageId": pageId }), completed: ++completedIndexes, total: selected.length, unit: $t("download-legacy-atlas.text_4fb249b9d7") }, signal);
      return { game, pageId, version, ...(locale !== defaultAtlasLocale && { locale }), recordCount: entries.length,
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
    throw new Error($t("download-legacy-atlas.text_95bb7ca492"));
  }
  const existing = await entry(workspace);
  if (existing && !existing.isDirectory()) throw new Error($t("download-legacy-atlas.text_c4b8b7fec9"));
  if (!existing) await mkdir(workspace, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (await realpath(workspace) !== workspace) throw new Error($t("download-legacy-atlas.text_c4b8b7fec9"));
  return workspace;
}

async function verifyExporterOutput(directory: string, signal?: AbortSignal) {
  const root = await entry(directory);
  if (!root) return;
  if (!root.isDirectory()) throw new Error($t("download-legacy-atlas.text_653f0b567a"));
  const pending = [directory];
  while (pending.length) {
    const parent = pending.pop()!;
    for (const name of await readdir(parent)) {
      signal?.throwIfAborted();
      const path = join(parent, name);
      const metadata = await lstat(path);
      if (metadata.isDirectory()) pending.push(path);
      else if (!metadata.isFile() || metadata.nlink !== 1) throw new Error($t("download-legacy-atlas.text_77ca65d8d6"));
    }
  }
}

async function matchesExportIndex(directory: string, map: Record<string, unknown>, { game, pageId, rows, locale = defaultAtlasLocale }: ExportScope,
  signal?: AbortSignal): Promise<boolean> {
  if (!rows) return true;
  const gameData = object(object(map.games)[game]);
  const localized = atlasLocaleBlock(gameData, locale);
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
    const { game, pageId, version, rows, recordCount, locale = defaultAtlasLocale } = index;
    signal?.throwIfAborted();
    const gameData = object(object(map.games)[game]);
    const page = object(object(atlasLocaleBlock(gameData, locale).pages)[pageId]);
    if (page.version === version) {
      const missing = Object.keys(object(page.records)).find(id => !rows.has(id));
      if (missing) throw new Error($t("download-legacy-atlas.text_a69c44183e", { "game": game, "pageId": pageId, "missing": missing }));
      if (page.recordCount === recordCount && await matchesExportIndex(directory, map, { game, pageId, version, recordCount, rows, locale }, signal)) {
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
  const profiles = new Map(scope.map((page) => [atlasPageKey(page), page]));
  const map = scope.some(({ rows }) => rows) ? object(await Bun.file(join(data, "map.json")).json().catch(() => undefined)) : {};
  const images = new Map<string, { file: string; sha256: string } | null>();
  for (const page of pages) {
    const { version, recordCount } = page;
    const key = atlasPageKey(page);
    const expected = profiles.get(key);
    if (expected?.version === version && expected.recordCount === recordCount &&
        await matchesExportIndex(data, map, expected, signal)) completed.add(key);
  }
  let placeholderRepairPage: string | undefined;
  // The original exporter also flags confirmed placeholders for future refreshes.
  for (const row of references) {
    signal?.throwIfAborted();
    const image = object(row);
    const { gameId, pageId, locale, status, retryable, placeholderReason } = image;
    if (typeof gameId !== "string" || typeof pageId !== "string") continue;
    const key = atlasPageKey({ game: gameId, pageId, locale: parseAtlasLocale(locale) });
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
  publishedBaseline?: string, request?: AtlasSourceFetch, refreshDetails = false, onProgress?: AtlasInitializationProgressCallback): Promise<T> {
  signal?.throwIfAborted();
  const workspace = await acquireWorkspace(path, await realpath(target));
  const lockFile = join(workspace, ".download.sqlite");
  const lockPath = await entry(lockFile);
  if (lockPath && !lockPath.isFile()) throw new Error($t("download-legacy-atlas.text_bf1bf7fb83"));
  const lock = new Database(lockFile);
  let stage: string | undefined;
  try {
    lock.exec("PRAGMA busy_timeout = 0");
    try {
      lock.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code?.startsWith("SQLITE_BUSY")) {
        throw new Error($t("download-legacy-atlas.text_3dafe5ba08"));
      }
      throw error;
    }
    const indexes = await selected();
    await reportProgress(onProgress, { stage: "cache", message: $t("download-legacy-atlas.text_cedf3f02d2") }, signal);
    const pages = indexes.map(({ rows: _rows, ...page }) => page);
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
      throw new Error($t("download-legacy-atlas.text_b7fd9bfe7e"));
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
    // Fresh exports use prior snapshots only as verified artwork donors.
    let checkedSeeds = 0;
    for (const seed of refreshDetails ? [] : sources) {
      const data = join(seed, "data");
      const changed = await changedAtlasSourceIndexes(data, remaining, signal).catch((error: unknown) => {
        if (data === publishedBaseline) throw error;
        signal?.throwIfAborted();
        return remaining;
      });
      const ready = remaining.filter(page => !changed.includes(page));
      if (ready.length) reusable.push({ seed, pages: ready });
      remaining = changed;
      await reportProgress(onProgress, { stage: "cache", message: $t("download-legacy-atlas.text_d56bc78b95", { "value1": indexes.length - remaining.length }), completed: ++checkedSeeds, total: sources.length, unit: $t("download-legacy-atlas.text_0066134b36") }, signal);
    }

    let source: string | undefined;
    if (remaining.length) {
      source = join(stage, "original");
      await nativeAtlasExport({ destination: source, cache, indexes: remaining, sourceRoots: sources, request, signal, refreshDetails, onProgress });
    }
    const recovery = nativeAtlasImageRecovery(cache, sources, request);
    for (const [index, donor] of reusable.entries()) {
      await reportProgress(onProgress, { stage: "assemble", message: $t("download-legacy-atlas.text_b5d3ed2aca"), completed: index, total: reusable.length, unit: $t("download-legacy-atlas.text_0066134b36") }, signal);
      const destination = join(stage, `merge-${index}`);
      const combined = source ? await assembleAtlasCandidate(source, donor.seed, destination, donor.pages, signal, recovery)
        : await copyAtlasSelectedPages(donor.seed, destination, donor.pages, signal, recovery);
      source = combined.directory;
      await reportProgress(onProgress, { stage: "assemble", message: $t("download-legacy-atlas.text_14e3c0ff4c"), completed: index + 1, total: reusable.length, unit: $t("download-legacy-atlas.text_0066134b36") }, signal);
    }
    if (!source) throw new Error($t("download-legacy-atlas.text_8a3f324c06"));
    const roles = indexes.filter(({ game, pageId }) => game === "gi" && pageId === "character");
    if (roles.length) {
      const { completeGenshinPortraits } = await import("./genshin-original-portraits.ts");
      for (const { version, locale } of roles) await completeGenshinPortraits(source, version, signal, request, locale, onProgress);
    }
    if (indexes.some(({ pageId }) => pageId === "character")) {
      const { completeAtlasRoleMaterials } = await import("./role-material-source.ts");
      await completeAtlasRoleMaterials(source, pages, signal, request, true, onProgress);
    }
    await reportProgress(onProgress, { stage: "validate", message: $t("download-legacy-atlas.text_e0f6853717") }, signal);
    const validated = await validateAtlasCandidate(join(source, "data"), pages, signal);
    if (!validated.ok) throw new Error($t("download-legacy-atlas.text_1771cc7cef", { "value1": validated.issues[0] ?? "" }));
    await reportProgress(onProgress, { stage: "validate", message: $t("download-legacy-atlas.text_cef83d8a3f"), completed: 1, total: 1, unit: $t("download-legacy-atlas.text_172fb7e67b") }, signal);
    return await consume(source, pages);
  } finally {
    try { if (stage) await rm(stage, { recursive: true, force: true }); }
    finally { lock.close(); }
  }
}

/** Read the prior pinned public versions and retain the audited per-page counts. */
export function downloadLegacyAtlas<T>(path: string, target: string, consume: (source: string) => Promise<T>,
  signal?: AbortSignal, onProgress?: AtlasInitializationProgressCallback): Promise<T> {
  const versions = Object.fromEntries(legacyAtlasSourcePages.map(({ game, version }) => [game, version]));
  return downloadAtlasExport(path, target, async () => {
    const indexes = await readSelectedExporterIndexes(versions, signal, undefined, undefined, undefined, onProgress);
    if (indexes.some(({ recordCount }, index) => recordCount !== legacyAtlasSourcePages[index]?.recordCount)) {
      throw new Error($t("download-legacy-atlas.text_a2620068b1"));
    }
    return indexes;
  }, consume, signal, undefined, undefined, false, onProgress);
}

/** Run all supported pages at the versions already selected from the original website manifest. */
export function downloadAtlasVersion<T>(path: string, target: string, versions: AtlasExportVersions,
  consume: (source: string, pages: readonly ExportPage[]) => Promise<T>, signal?: AbortSignal,
  request?: AtlasSourceFetch, scope?: readonly AtlasExportPageSelection[], publishedBaseline?: string, locale = defaultAtlasLocale, onProgress?: AtlasInitializationProgressCallback): Promise<T> {
  return downloadAtlasExport(path, target, () => readSelectedExporterIndexes(versions, signal, request, scope, locale, onProgress), consume, signal,
    publishedBaseline, request, false, onProgress);
}

/** Read fresh indexes and detail JSON. Prior snapshots and caches may only supply verified artwork. */
export function redownloadAtlasVersion<T>(path: string, target: string, versions: AtlasExportVersions,
  consume: (source: string, pages: readonly ExportPage[]) => Promise<T>, signal?: AbortSignal,
  request?: AtlasSourceFetch, scope?: readonly AtlasExportPageSelection[], imageSeedBaseline?: string, locale = defaultAtlasLocale, onProgress?: AtlasInitializationProgressCallback): Promise<T> {
  return downloadAtlasExport(path, target, () => readSelectedExporterIndexes(versions, signal, request, scope, locale, onProgress), consume, signal,
    imageSeedBaseline, request, true, onProgress);
}

/** Use the same checked source indexes for discovery and for the downloaded candidate. */
export function downloadAtlasVersionFromIndexes<T>(path: string, target: string, indexes: readonly AtlasSourceIndex[],
  consume: (source: string, pages: readonly ExportPage[]) => Promise<T>, signal?: AbortSignal,
  publishedBaseline?: string, request?: AtlasSourceFetch, onProgress?: AtlasInitializationProgressCallback): Promise<T> {
  return downloadAtlasExport(path, target, async () => indexes, consume, signal, publishedBaseline, request, false, onProgress);
}
