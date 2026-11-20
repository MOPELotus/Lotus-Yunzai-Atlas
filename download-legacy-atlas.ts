import { Database } from "bun:sqlite";
import { lstat, mkdir, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateFile, candidateImageReference, hashCandidateFile } from "./candidate-gallery.ts";
import { legacyAtlasSourcePages } from "./legacy-source-profile.ts";
import { object } from "./source-values.ts";
import { validateAtlasCandidate } from "./validate-candidate.ts";

const originalExporter = "https://github.com/MOPELotus/nanoka-atlas-backend.git";
const exporterRevision = "0496f9cf725d815b89f118b30f681cae82ad2f4e";
const networkPolicy = fileURLToPath(new URL("./public-atlas-network.mjs", import.meta.url));

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

export async function inspectExporterPages(root: string, signal?: AbortSignal) {
  const data = join(root, "data");
  await verifyExporterOutput(data, signal);
  await verifyExporterOutput(join(root, "gallery"), signal);
  const gallery = await Bun.file(join(data, "gallery-index.json")).json().catch(() => undefined);
  const references = object(gallery).images;
  const completed = new Set<string>();
  const corruptImages = new Set<string>();
  if (!Array.isArray(references)) return { completed, corruptImages };
  const { pages } = await validateAtlasCandidate(data, [], signal);
  const profiles = new Map(legacyAtlasSourcePages.map((page) => [`${page.game}/${page.pageId}`, page]));
  const images = new Map<string, { file: string; sha256: string } | null>();
  for (const { game, pageId, version, recordCount } of pages) {
    const key = `${game}/${pageId}`;
    const expected = profiles.get(key);
    if (expected?.version === version && expected.recordCount === recordCount) completed.add(key);
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
  return { completed, corruptImages };
}

/** Keep the pinned backend separate from the runtime, and reuse its incremental export on retries. */
export async function downloadLegacyAtlas<T>(path: string, target: string,
  consume: (source: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
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
    const root = await prepareExporter(workspace, git, signal);
    await child([corepack, "yarn", "install", "--immutable", "--mode=skip-build"], root, signal);
    const { completed, corruptImages } = await inspectExporterPages(root, signal);
    for (const file of corruptImages) {
      signal?.throwIfAborted();
      // Incremental mode trusts the recorded hash as long as an existing file has bytes.
      await unlink(file);
    }
    for (const { game, pageId, version } of legacyAtlasSourcePages) {
      if (completed.has(`${game}/${pageId}`)) continue;
      await child([node, "--import", networkPolicy, "src/scrape.mjs", "--mode", "incremental", "--game", game,
        "--locale", "zh", "--version", `${game}=${version}`, "--pages", `${game}=${pageId}`], root, signal);
    }
    return await consume(root);
  } finally {
    lock.close();
  }
}
