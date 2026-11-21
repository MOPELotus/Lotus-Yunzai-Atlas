import { Database } from "bun:sqlite";
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateFile, candidateImageReference, hashCandidateFile } from "./candidate-gallery.ts";
import type { Game } from "./catalog.ts";
import { seedExporterFromPublished } from "./export-workspace-seed.ts";
import { legacyAtlasSourcePages } from "./legacy-source-profile.ts";
import { atlasSourceOrigin, readAtlasSourceBytes, type AtlasSourceFetch } from "./source-transport.ts";
import { object } from "./source-values.ts";
import { type AtlasCandidatePage, validateAtlasCandidate } from "./validate-candidate.ts";

const originalExporter = "https://github.com/MOPELotus/nanoka-atlas-backend.git";
const exporterRevision = "0496f9cf725d815b89f118b30f681cae82ad2f4e";
const networkPolicy = fileURLToPath(new URL("./public-atlas-network.mjs", import.meta.url));
const atlasVersion = /^(0|[1-9]\d{0,7})(?:\.(?:0|[1-9]\d{0,7})){1,3}(?:\+(?:0|[1-9]\d{0,14}))?$/u;
const maxExportIndexBytes = 16 * 1024 * 1024;
const seedStagingPrefix = ".atlas-export-seed-";
const seedStagingName = /^\.atlas-export-seed-[A-Za-z0-9]{6}$/u;

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
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      const listing = indexShape === "array" && Array.isArray(value) ? value : object(value);
      const entries = Object.entries(listing);
      if ((indexShape === "array" && !Array.isArray(listing)) || !entries.length ||
          entries.some(([, row]) => row !== object(row))) throw new Error(`${game}/${pageId} 原站索引结构无效。`);
      return { game, pageId, version, recordCount: entries.length,
        rows: new Map(entries.map(([id, row]) => [id, JSON.stringify(row)])) };
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

function executable(name: string) {
  const path = Bun.which(name);
  if (!path) throw new Error(`公网图鉴初始化需要 ${name}。`);
  return path;
}

async function child(argv: string[], cwd: string, signal?: AbortSignal, quiet = false) {
  signal?.throwIfAborted();
  const command = Bun.spawn(argv, {
    cwd, signal, stdin: "ignore", stdout: quiet ? "pipe" : 2, stderr: "inherit",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", NODE_USE_ENV_PROXY: "1" },
  });
  const stdout = typeof command.stdout === "object" ? new Response(command.stdout).text() : undefined;
  const code = await command.exited;
  signal?.throwIfAborted();
  if (code !== 0) throw new Error(`${basename(argv[0]!)} 未成功结束（${code}），下载工作目录已保留。`);
  return (await stdout)?.trim() ?? "";
}

async function prepareExporter(workspace: string, git: string, signal?: AbortSignal) {
  const root = join(workspace, "backend");
  const path = await entry(root);
  if (path && !path.isDirectory()) throw new Error("图鉴下载器目录须为实体目录。");
  const run = (args: string[], quiet = false) =>
    child([git, "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", ...args], root, signal, quiet);
  if (!path) await mkdir(root, { mode: 0o700 });
  const metadata = await entry(join(root, ".git"));
  if (!metadata && (await readdir(root)).length === 0) {
    await run(["init", "--quiet"]);
  } else if (!metadata?.isDirectory()) {
    throw new Error("图鉴下载目录中的 Git 仓库须由初始化器建立。");
  }
  const head = await run(["rev-parse", "--verify", "-q", "HEAD"], true).catch((error: unknown) => {
    signal?.throwIfAborted();
    return error instanceof Error ? "" : Promise.reject(error);
  });
  if (!head) {
    await run(["fetch", "--no-tags", "--depth=1", originalExporter, exporterRevision]);
    await run(["checkout", "--detach", exporterRevision]);
  }
  if ((await run(["rev-parse", "HEAD"], true)) !== exporterRevision ||
      await run(["status", "--porcelain", "--untracked-files=no"], true)) {
    throw new Error("图鉴下载器源码或固定版本不符，请使用新的下载工作目录。");
  }
  return root;
}

async function prepareWorkspaceExporter(workspace: string, git: string, publishedBaseline?: string, signal?: AbortSignal) {
  const root = join(workspace, "backend");
  if (!publishedBaseline) return await prepareExporter(workspace, git, signal);
  for (const child of await readdir(workspace, { withFileTypes: true })) {
    signal?.throwIfAborted();
    if (child.isDirectory() && seedStagingName.test(child.name)) {
      await rm(join(workspace, child.name), { recursive: true, force: true });
    }
  }
  if (await entry(root)) return await prepareExporter(workspace, git, signal);
  const data = await realpath(publishedBaseline);
  if (contains(workspace, data) || contains(data, workspace)) {
    throw new Error("图鉴下载种子必须位于独立的发布快照。");
  }
  const staged = await mkdtemp(join(workspace, seedStagingPrefix));
  try {
    const cache = join(staged, "snapshot");
    await seedExporterFromPublished(data, cache, signal);
    const prepared = await prepareExporter(staged, git, signal);
    await rename(join(cache, "data"), join(prepared, "data"));
    const gallery = join(cache, "gallery");
    if (await entry(gallery)) await rename(gallery, join(prepared, "gallery"));
    signal?.throwIfAborted();
    if (await entry(root)) throw new Error("图鉴下载工作区已有导出器，未替换。");
    await rename(prepared, root);
    return root;
  } finally {
    await rm(staged, { recursive: true, force: true });
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
    const item = object(await Bun.file(file).json());
    if (JSON.stringify(object(item.content).list) !== row) return false;
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

async function downloadAtlasExport<T>(path: string, target: string, selected: () => Promise<readonly ExportScope[]>,
  consume: (source: string, pages: readonly ExportPage[]) => Promise<T>, signal?: AbortSignal,
  publishedBaseline?: string, request?: AtlasSourceFetch): Promise<T> {
  signal?.throwIfAborted();
  const workspace = await acquireWorkspace(path, await realpath(target));
  const lockFile = join(workspace, ".download.sqlite");
  const lockPath = await entry(lockFile);
  if (lockPath && !lockPath.isFile()) throw new Error("图鉴下载锁须为实体文件。");
  const lock = new Database(lockFile);
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
    const git = executable("git");
    const corepack = executable("corepack");
    const node = executable("node");
    const root = await prepareWorkspaceExporter(workspace, git, publishedBaseline, signal);
    await child([corepack, "yarn", "install", "--immutable", "--mode=skip-build"], root, signal);
    const scope = await selected();
    const initial = await inspectExporterPages(root, signal, scope);
    const { completed, corruptImages } = initial;
    for (const file of corruptImages) {
      signal?.throwIfAborted();
      // Incremental mode trusts the recorded hash as long as an existing file has bytes.
      await unlink(file);
    }
    for (const { game, pageId, version } of scope) {
      if (completed.has(`${game}/${pageId}`)) continue;
      await child([node, "--import", networkPolicy, "src/scrape.mjs", "--mode", "incremental", "--game", game,
        "--locale", "zh", "--version", `${game}=${version}`, "--pages", `${game}=${pageId}`], root, signal);
    }
    if (scope.some(({ rows }) => rows)) {
      const verified = completed.size === scope.length ? initial : await inspectExporterPages(root, signal, scope);
      const missing = scope.filter(({ game, pageId }) => !verified.completed.has(`${game}/${pageId}`));
      if (missing.length) throw new Error(`原导出未完成所选图鉴：${missing.map(({ game, pageId }) => `${game}/${pageId}`).join("、")}。`);
      if (scope.length === legacyAtlasSourcePages.length && !verified.exactScope) {
        throw new Error("原导出的分类范围与所选图鉴不符。");
      }
    }
    const roles = scope.find(({ game, pageId, rows }) => game === "gi" && pageId === "character" && rows);
    if (roles) {
      const { completeGenshinPortraits } = await import("./genshin-original-portraits.ts");
      await completeGenshinPortraits(root, roles.version, signal, request);
    }
    const pages = scope.map(({ game, pageId, version, recordCount }) => ({ game, pageId, version, recordCount }));
    if (scope.some(({ pageId, rows }) => pageId === "character" && rows)) {
      const { completeAtlasRoleMaterials } = await import("./role-material-source.ts");
      await completeAtlasRoleMaterials(root, pages, signal, request);
    }
    return await consume(root, pages);
  } finally {
    lock.close();
  }
}

/** Replay the original fixed export with its audited per-page counts. */
export function downloadLegacyAtlas<T>(path: string, target: string, consume: (source: string) => Promise<T>,
  signal?: AbortSignal): Promise<T> {
  return downloadAtlasExport(path, target, async () => legacyAtlasSourcePages, consume, signal);
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
