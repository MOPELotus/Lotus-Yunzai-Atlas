import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { lstat, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";

export const atlasResetTarget = ".atlas-reset";
export type AtlasPointer = number | "reset" | null;

export class AtlasSnapshotReset extends Error {
  constructor() {
    super($t("snapshot-pointer.text_5b05234db1"));
  }
}

export function isAtlasSnapshotVersion(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function atlasSnapshotTarget(version: number): string {
  return `snapshots/${version}/data`;
}

export async function readAtlasPublicationPointer(path: string): Promise<AtlasPointer> {
  let target: string;
  try {
    target = await readlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
    throw error;
  }
  if (target === atlasResetTarget) return "reset";
  const match = /^snapshots\/([1-9][0-9]*)\/data$/u.exec(target);
  const version = Number(match?.[1]);
  if (!isAtlasSnapshotVersion(version) || atlasSnapshotTarget(version) !== target) {
    throw new Error($t("snapshot-pointer.text_9d0e73c167"));
  }
  return version;
}

export async function readAtlasSnapshotPointer(path: string): Promise<number | null> {
  const pointer = await readAtlasPublicationPointer(path);
  return pointer === "reset" ? null : pointer;
}

export async function discoverAtlasDataDirectory(directory: string) {
  const atlas = await realpath(directory);
  const version = await readAtlasPublicationPointer(join(atlas, "current"));
  if (version === "reset") throw new AtlasSnapshotReset();
  if (version === null) return { root: await realpath(join(atlas, "data")), version };

  // Resolve the captured target, not the moving `current` alias.
  const root = join(atlas, atlasSnapshotTarget(version));
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) {
    throw new Error($t("snapshot-pointer.text_52b3665313"));
  }
  return { root, version };
}
