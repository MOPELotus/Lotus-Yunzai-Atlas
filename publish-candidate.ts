import { Database } from "bun:sqlite";
import { lstat, readFile, readlink, realpath, rename, symlink, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { candidateFile, candidateGallery } from "./candidate-gallery.ts";
import { object } from "./source-values.ts";
import { validateAtlasCandidate, type AtlasCandidateValidation } from "./validate-candidate.ts";

type Version = number | null;

export type AtlasPublication =
  | { readonly status: "published"; readonly version: number; readonly directory: string }
  | { readonly status: "stale"; readonly current: Version }
  | { readonly status: "invalid"; readonly issues: readonly string[] }
  | { readonly status: "busy" };

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isVersion(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function relativeTarget(version: number): string {
  return `snapshots/${version}/data`;
}

async function readPointer(path: string): Promise<Version> {
  let target: string;
  try {
    target = await readlink(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  const match = /^snapshots\/([1-9][0-9]*)\/data$/u.exec(target);
  const version = Number(match?.[1]);
  if (!isVersion(version)) throw new Error("图鉴发布指针格式无效。");
  return version;
}

export async function readAtlasSnapshotVersion(root: string): Promise<Version> {
  return readPointer(join(await realpath(root), "current"));
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

async function commitPointer(root: string, version: number, signal?: AbortSignal) {
  const pending = join(root, ".current-next");
  // Only writers holding the database lock touch this link. A killed writer may leave it behind.
  if (await readPointer(pending) !== null) await unlink(pending);
  await symlink(relativeTarget(version), pending, "dir");
  try {
    signal?.throwIfAborted();
    await rename(pending, join(root, "current"));
  } catch (error) {
    await unlink(pending);
    throw error;
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
export async function publishAtlasCandidate(root: string, expected: Version, version: number,
  expectedPages: AtlasCandidateValidation["pages"], signal?: AbortSignal): Promise<AtlasPublication> {
  signal?.throwIfAborted();
  if (!isVersion(version) || (expected !== null && !isVersion(expected))) throw new Error("图鉴发布版本须为正整数。");
  const directory = await realpath(root);
  const database = await lockPublication(join(directory, ".publication.sqlite"), signal);
  if (!database) return { status: "busy" };
  try {
    const current = await readPointer(join(directory, "current"));
    if (current !== expected || (current !== null && version <= current)) return { status: "stale", current };

    const candidate = join(directory, relativeTarget(version));
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

    await commitPointer(directory, version, signal);
    return { status: "published", version, directory: candidate };
  } finally {
    database.close();
  }
}
