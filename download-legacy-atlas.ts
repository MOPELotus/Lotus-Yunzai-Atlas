import { Database } from "bun:sqlite";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { legacyAtlasSourcePages } from "./legacy-source-profile.ts";
import { object } from "./source-values.ts";

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

export async function completedExporterPages(root: string): Promise<ReadonlySet<string>> {
  const data = join(root, "data");
  const map = await Bun.file(join(data, "map.json")).json().catch(() => undefined);
  const gallery = await Bun.file(join(data, "gallery-index.json")).json().catch(() => undefined);
  const references = object(gallery).images;
  if (!map || !Array.isArray(references)) return new Set();
  // The original exporter also flags confirmed placeholders for future refreshes.
  const unfinished = new Set(references.map(object).flatMap(({ gameId, pageId, status, retryable, placeholderReason }) => {
    const acceptedPlaceholder = status === "placeholder" && retryable === false &&
      (placeholderReason === "remote_missing" || placeholderReason === "no_candidates");
    return status === "downloaded" || acceptedPlaceholder ? [] : [`${gameId}/${pageId}`];
  }));
  return new Set(legacyAtlasSourcePages.flatMap(({ game, pageId, version, recordCount }) => {
    const gameData = object(object(object(map).games)[game]);
    const locale = object(object(gameData.locales).zh);
    const record = object(object(locale.pages)[pageId]);
    const key = `${game}/${pageId}`;
    return record.version === version && record.sampled === false && record.recordCount === recordCount &&
      record.totalRecordCount === recordCount && Object.keys(object(record.records)).length === recordCount &&
      !unfinished.has(key) ? [key] : [];
  }));
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
    const completed = await completedExporterPages(root);
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
