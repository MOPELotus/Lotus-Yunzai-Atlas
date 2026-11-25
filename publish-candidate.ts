import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { atlasPageKey } from "./locale.ts";
import { Database } from "bun:sqlite";
import { lstat, mkdir, readdir, realpath, rename, rm, rmdir, stat, symlink, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { candidateGallery } from "./candidate-gallery.ts";
import { atlasResetTarget, atlasSnapshotTarget, isAtlasSnapshotVersion, readAtlasPublicationPointer,
  readAtlasSnapshotPointer, type discoverAtlasDataDirectory } from "./snapshot-pointer.ts";
import { atlasRootIsEmpty, discoverRuntimeAtlasDataDirectory } from "./legacy-atlas-directory.ts";
import { atlasCandidateItems, retainAtlasGallery } from "./retain-gallery.ts";
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

export interface AtlasPublicationOptions {
  readonly preparation?: AtlasPreparation;
  readonly retainGallery?: boolean;
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
    if (!(await lstat(path)).isFile()) throw new Error($t("publish-candidate.text_0829ad6eb5"));
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
  const gallery = candidateGallery();
  for await (const { game, item } of atlasCandidateItems(candidate, pages, signal)) {
    await gallery.include(item, game, dirname(candidate), signal);
  }
}

/**
 * The private publication root owns immutable snapshots at snapshots/<version>.
 * Readers use root/current as their data directory. Old versions stay available to pinned readers.
 * The caller provides the full page list from its assembled candidate and stops writing before publication.
 */
async function publish(root: string, expected: Version, expectedPages: AtlasCandidateValidation["pages"],
  prepare: (root: string) => Promise<PreparedPublication>, signal?: AbortSignal, initialize: Initialization = false,
  options?: AtlasPublicationOptions): Promise<AtlasPublication> {
  const { preparation, retainGallery } = options ?? {};
  signal?.throwIfAborted();
  if (expected !== null && !isAtlasSnapshotVersion(expected)) throw new Error($t("publish-candidate.text_d804e47d07"));
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
      return { status: "invalid", issues: [$t("publish-candidate.text_fc535c7ff3")] };
    }
    const validation = await validateAtlasCandidate(candidate, expectedPages, signal);
    if (!validation.ok) return { status: "invalid", issues: validation.issues };
    const expectedKeys = new Set(expectedPages.map(atlasPageKey));
    if (expectedKeys.size !== expectedPages.length || validation.pages.length !== expectedKeys.size) {
      return { status: "invalid", issues: [$t("publish-candidate.text_7ebd0a02a0")] };
    }
    try {
      await verifyGallery(candidate, validation.pages, signal);
      if (retainGallery && !preparation) {
        const baseline = pointer === "reset" ? undefined : await discoverRuntimeAtlasDataDirectory(directory)
          .then(({ root }) => root, error => {
            if (errorCode(error) !== "ENOENT") throw error;
            return undefined;
          });
        await retainAtlasGallery(candidate, validation.pages, baseline, signal);
        await verifyGallery(candidate, validation.pages, signal);
      }
    } catch (error) {
      signal?.throwIfAborted();
      const issue = errorCode(error) ? $t("publish-candidate.text_314d461167") :
        error instanceof Error ? error.message : $t("publish-candidate.text_b3d0b59a93");
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
      await prunePrepared(target, version).catch(() => console.warn($t("publish-candidate.text_09f1469a96")));
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

const occupiedAtlasData = { status: "invalid", issues: [$t("publish-candidate.text_f9f3f8cdc6")] } as const;
const existingLegacyData = { status: "invalid", issues: [$t("publish-candidate.text_4aba396577")] } as const;

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
  if (!isAtlasSnapshotVersion(version)) throw new Error($t("publish-candidate.text_d804e47d07"));
  return publish(root, expected, expectedPages, async (directory) => ({
    data: join(directory, atlasSnapshotTarget(version)), version,
  }), signal);
}

/** Move an assembled, caller-owned private candidate into the version store under the publication lock. */
export async function publishPreparedAtlasCandidate(root: string, expected: Version, prepared: string,
  expectedPages: AtlasCandidateValidation["pages"], signal?: AbortSignal, initialize: Initialization = false,
  options?: AtlasPublicationOptions): Promise<AtlasPublication> {
  if (initialize && expected !== null) throw new Error($t("publish-candidate.text_91718baacd"));
  return publish(root, expected, expectedPages, async (directory) => {
    const stagedRoot = dirname(prepared);
    if (dirname(stagedRoot) !== dirname(directory) || !basename(stagedRoot).startsWith(atlasApplyStagingPrefix) ||
        basename(prepared) !== "candidate") throw new Error($t("publish-candidate.text_76e28bf95f"));
    const target = options?.preparation ? join(directory, ".prepared") : directory;
    if (options?.preparation) {
      await mkdir(target, { mode: 0o700 }).catch((error) => {
        if (errorCode(error) !== "EEXIST") throw error;
      });
      if (await realpath(target) !== target || !(await lstat(target)).isDirectory()) {
        throw new Error($t("publish-candidate.text_1c1a348d03"));
      }
    }
    const snapshots = join(target, "snapshots");
    await mkdir(snapshots, { mode: 0o700 }).catch((error) => {
      if (errorCode(error) !== "EEXIST") throw error;
    });
    if (await realpath(snapshots) !== snapshots || !(await lstat(snapshots)).isDirectory()) {
      throw new Error($t("publish-candidate.text_f675720333"));
    }
    if ((await stat(prepared)).dev !== (await stat(snapshots)).dev) {
      throw new Error($t("publish-candidate.text_4ac3811b2b"));
    }
    let highest = expected ?? 0;
    for (const name of await readdir(snapshots)) {
      const version = Number(name);
      if (isAtlasSnapshotVersion(version) && String(version) === name) highest = Math.max(highest, version);
    }
    const version = highest + 1;
    if (!isAtlasSnapshotVersion(version)) throw new Error($t("publish-candidate.text_87a9206a79"));
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
  }, signal, initialize, options);
}
