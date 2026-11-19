import { lstat, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";

export function isAtlasSnapshotVersion(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function atlasSnapshotTarget(version: number): string {
  return `snapshots/${version}/data`;
}

export async function readAtlasSnapshotPointer(path: string): Promise<number | null> {
  let target: string;
  try {
    target = await readlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
    throw error;
  }
  const match = /^snapshots\/([1-9][0-9]*)\/data$/u.exec(target);
  const version = Number(match?.[1]);
  if (!isAtlasSnapshotVersion(version) || atlasSnapshotTarget(version) !== target) {
    throw new Error("图鉴发布指针格式无效。");
  }
  return version;
}

export async function discoverAtlasDataDirectory(directory: string) {
  const atlas = await realpath(directory);
  const version = await readAtlasSnapshotPointer(join(atlas, "current"));
  if (version === null) return { root: await realpath(join(atlas, "data")), version };

  // Resolve the captured target, not the moving `current` alias.
  const root = join(atlas, atlasSnapshotTarget(version));
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) {
    throw new Error("图鉴发布指针须指向实体快照目录。");
  }
  return { root, version };
}
