import { Database } from "bun:sqlite";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, symlink, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { candidateFile, candidateGallery } from "./candidate-gallery.ts";
import { atlasResetTarget, atlasSnapshotTarget, isAtlasSnapshotVersion, readAtlasPublicationPointer,
  readAtlasSnapshotPointer, type discoverAtlasDataDirectory } from "./snapshot-pointer.ts";
import { atlasRootIsEmpty } from "./legacy-atlas-directory.ts";
import { object } from "./source-values.ts";
import { validateAtlasCandidate, type AtlasCandidateValidation } from "./validate-candidate.ts";

type Version = number | null;
type Initialization = boolean | "empty-only";
export const atlasApplyStagingPrefix = ".atlas-apply-";

export type AtlasPublication =
  | { readonly status: "published" | "prepared"; readonly version: number; readonly directory: string }
  | { readonly status: "stale"; readonly current: Version }
  | { readonly status: "invalid"; readonly issues: readonly string[] }
  | { readonly status: "busy" };

export interface AtlasPreparation {
  baseline?: Awaited<ReturnType<typeof discoverAtlasDataDirectory>>;
}

interface PreparedPublication {
  readonly data: string;
  readonly version: number;
  readonly target?: string;
  readonly promote?: () => Promise<void>;
}

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export async function readAtlasSnapshotVersion(root: string): Promise<Version> {
  return readAtlasSnapshotPointer(join(await realpath(root), "current"));
}

async function lockPublication(path: string, signal?: AbortSignal): Promise<Database | undefined> {
  try {
    if (!(await lstat(path)).isFile()) throw new Error("图鉴发布锁须为实体文件。");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  // Keep the database path stable. Process exit releases SQLite's OS lock.
  const database = new Database(path);
  const deadline = performance.now() + 2_000;
  let locked = false;
  try {
    database.exec("PRAGMA busy_timeout = 0");
    while (performance.now() < deadline) {
      signal?.throwIfAborted();
      try {
        database.exec("BEGIN IMMEDIATE");
        locked = true;
        return database;
      } catch (error) {
        if (!errorCode(error)?.startsWith("SQLITE_BUSY")) throw error;
      }
      await delay(20, undefined, { signal });
    }
  } finally {
    if (!locked) database.close();
  }
}

async function commitPointer(root: string, target: string, signal?: AbortSignal) {
  const pending = join(root, ".current-next");
  // Only writers holding the database lock touch this link. A killed writer may leave it behind.
  if (await readAtlasPublicationPointer(pending) !== null) await unlink(pending);
  await symlink(target, pending, "dir");
  try {
    signal?.throwIfAborted();
    await rename(pending, join(root, "current"));
  } catch (error) {
    await unlink(pending);
    throw error;
  }
}

export async function resetAtlasSnapshot(root: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const directory = await realpath(root).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") throw error;
  });
  if (!directory) return { status: "empty" } as const;
  const database = await lockPublication(join(directory, ".publication.sqlite"), signal);
  if (!database) return { status: "busy" } as const;
  try {
    const pointer = await readAtlasPublicationPointer(join(directory, "current"));
    if (pointer === "reset") return { status: "reset", previous: null } as const;
    if (pointer === null && !await hasLegacyAtlasData(directory)) return { status: "empty" } as const;
    await commitPointer(directory, atlasResetTarget, signal);
    return { status: "reset", previous: pointer } as const;
  } finally {
    database.close();
  }
}

async function verifyGallery(candidate: string, pages: AtlasCandidateValidation["pages"], signal?: AbortSignal) {
  const map: unknown = JSON.parse(await readFile(await candidateFile(candidate, "map.json"), "utf8"));
  const games = object(object(map).games);
  const gallery = candidateGallery();
  for (const { game, pageId } of pages) {
    const pageMap = object(object(object(object(games[game]).locales).zh).pages);
    const { records } = object(pageMap[pageId]);
    for (const record of Object.values(object(records))) {
      signal?.throwIfAborted();
      const { path } = object(record);
      if (typeof path !== "string" || !path.startsWith("items/")) throw new Error("候选条目路径无效。");
      const item: unknown = JSON.parse(await readFile(await candidateFile(candidate, path), "utf8"));
      await gallery.include(item, game, dirname(candidate), signal);
    }
  }
}

/**
 * The private publication root owns immutable snapshots at snapshots/<version>.
 * Readers use root/current as their data directory. Old versions stay available to pinned readers.
 * The caller provides the full page list from its assembled candidate and stops writing before publication.
 */
async function publish(root: string, expected: Version, expectedPages: AtlasCandidateValidation["pages"],
  prepare: (root: string) => Promise<PreparedPublication>, signal?: AbortSignal, initialize: Initialization = false,
  preparation?: AtlasPreparation): Promise<AtlasPublication> {
  signal?.throwIfAborted();
  if (expected !== null && !isAtlasSnapshotVersion(expected)) throw new Error("图鉴发布版本须为正整数。");
  const directory = await realpath(root);
  const database = await lockPublication(join(directory, ".publication.sqlite"), signal);
  if (!database) return { status: "busy" };
  try {
    const pointer = await readAtlasPublicationPointer(join(directory, "current"));
    const current = pointer === "reset" ? null : pointer;
    if (pointer === "reset" && !initialize) return { status: "stale", current };
    if (current !== expected) return { status: "stale", current };
    if (initialize === "empty-only" && !await atlasRootIsEmpty(directory)) return occupiedAtlasData;
    if (initialize && await hasLegacyAtlasData(directory)) return existingLegacyData;

    const { data: candidate, version, promote, target = directory } = await prepare(directory);
    if (current !== null && version <= current) return { status: "stale", current };
    const candidateRoot = await realpath(candidate).catch(() => undefined);
    if (candidateRoot !== candidate || !(await lstat(candidate).catch(() => undefined))?.isDirectory()) {
      return { status: "invalid", issues: ["发布候选 data 须为发布根内的实体目录。"] };
    }
    const validation = await validateAtlasCandidate(candidate, expectedPages, signal);
    if (!validation.ok) return { status: "invalid", issues: validation.issues };
    const expectedKeys = new Set(expectedPages.map(({ game, pageId }) => `${game}/${pageId}`));
    if (expectedKeys.size !== expectedPages.length || validation.pages.length !== expectedKeys.size) {
      return { status: "invalid", issues: ["发布候选与预期完整分类清单不一致。"] };
    }
    try {
      await verifyGallery(candidate, validation.pages, signal);
    } catch (error) {
      signal?.throwIfAborted();
      const issue = errorCode(error) ? "发布候选引用的图库文件缺失或不可读。" :
        error instanceof Error ? error.message : "发布候选图库校验失败。";
      return { status: "invalid", issues: [issue] };
    }

    signal?.throwIfAborted();
    if (initialize === "empty-only" && !await atlasRootIsEmpty(directory)) return occupiedAtlasData;
    if (initialize && await hasLegacyAtlasData(directory)) return existingLegacyData;
    await promote?.();
    const path = join(target, atlasSnapshotTarget(version));
    await commitPointer(target, atlasSnapshotTarget(version), signal);
    if (preparation) {
      // The private candidate advances without modifying the generation of the live branch.
      preparation.baseline = { version: current, root: path };
      await prunePrepared(target, version).catch(() => console.warn("[atlas] 未能清理旧图鉴候选。"));
      return { status: "prepared", version, directory: path };
    }
    return { status: "published", version, directory: path };
  } finally {
    database.close();
  }
}

async function prunePrepared(root: string, keep: number) {
  const snapshots = join(root, "snapshots");
  for (const entry of await readdir(snapshots, { withFileTypes: true })) {
    const version = Number(entry.name);
    if (entry.isDirectory() && isAtlasSnapshotVersion(version) && String(version) === entry.name && version < keep) {
      await rm(join(snapshots, entry.name), { recursive: true, force: true });
    }
  }
}

const occupiedAtlasData = { status: "invalid", issues: ["图鉴受管目录已有数据，未自动初始化。"] } as const;
const existingLegacyData = { status: "invalid", issues: ["图鉴已有旧版 data，首版初始化未执行。"] } as const;

export async function hasLegacyAtlasData(root: string): Promise<boolean> {
  if (await readAtlasPublicationPointer(join(root, "current")) === "reset") return false;
  try {
    await lstat(join(root, "data"));
    return true;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return false;
  }
}

export async function publishAtlasCandidate(root: string, expected: Version, version: number,
  expectedPages: AtlasCandidateValidation["pages"], signal?: AbortSignal): Promise<AtlasPublication> {
  if (!isAtlasSnapshotVersion(version)) throw new Error("图鉴发布版本须为正整数。");
  return publish(root, expected, expectedPages, async (directory) => ({
    data: join(directory, atlasSnapshotTarget(version)), version,
  }), signal);
}

/** Move an assembled, caller-owned private candidate into the version store under the publication lock. */
export async function publishPreparedAtlasCandidate(root: string, expected: Version, prepared: string,
  expectedPages: AtlasCandidateValidation["pages"], signal?: AbortSignal, initialize: Initialization = false,
  preparation?: AtlasPreparation): Promise<AtlasPublication> {
  if (initialize && expected !== null) throw new Error("首版图鉴初始化要求没有现用指针。");
  return publish(root, expected, expectedPages, async (directory) => {
    const stagedRoot = dirname(prepared);
    if (dirname(stagedRoot) !== dirname(directory) || !basename(stagedRoot).startsWith(atlasApplyStagingPrefix) ||
        basename(prepared) !== "candidate") throw new Error("图鉴发布只接收相邻私有暂存中的合成候选。");
    const target = preparation ? join(directory, ".prepared") : directory;
    if (preparation) {
      await mkdir(target, { mode: 0o700 }).catch((error) => {
        if (errorCode(error) !== "EEXIST") throw error;
      });
      if (await realpath(target) !== target || !(await lstat(target)).isDirectory()) {
        throw new Error("图鉴候选库须为发布根内的实体目录。");
      }
    }
    const snapshots = join(target, "snapshots");
    await mkdir(snapshots, { mode: 0o700 }).catch((error) => {
      if (errorCode(error) !== "EEXIST") throw error;
    });
    if (await realpath(snapshots) !== snapshots || !(await lstat(snapshots)).isDirectory()) {
      throw new Error("图鉴版本库须为发布根内的实体目录。");
    }
    if ((await stat(prepared)).dev !== (await stat(snapshots)).dev) {
      throw new Error("图鉴候选暂存与版本库须位于同一文件系统。");
    }
    let highest = expected ?? 0;
    for (const name of await readdir(snapshots)) {
      const version = Number(name);
      if (isAtlasSnapshotVersion(version) && String(version) === name) highest = Math.max(highest, version);
    }
    const version = highest + 1;
    if (!isAtlasSnapshotVersion(version)) throw new Error("图鉴发布版本已用尽。");
    const destination = dirname(join(target, atlasSnapshotTarget(version)));
    return {
      data: join(prepared, "data"), version, target,
      promote: async () => {
        // Reserve the name without replacing any pre-existing snapshot, even an empty directory.
        await mkdir(destination, { mode: 0o700 });
        await rename(prepared, destination);
        await rmdir(stagedRoot);
      },
    };
  }, signal, initialize, preparation);
}
