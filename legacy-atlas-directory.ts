import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { discoverAtlasDataDirectory } from "./snapshot-pointer.ts";

const formerPluginPaths = ["Lotus-Plugin", "Lotus-ReFactor"] as const;

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
  }
}

export class LegacyAtlasSourceConflict extends Error {
  constructor() {
    super("检测到两个不同的旧图鉴导出。请设置 LOTUS_ATLAS_DATA_DIR，或在初始化时指定来源目录。");
  }
}

export async function findLegacyAtlasExport(atlasRoot: string): Promise<string | undefined> {
  const plugins = resolve(atlasRoot, "../../plugins");
  const sources = new Set<string>();
  for (const name of formerPluginPaths) {
    const exportRoot = join(plugins, name, "data", "atlas");
    const index = await lstatIfPresent(join(exportRoot, "data", "map.json"));
    if (!index) continue;
    if (!index.isFile()) throw new Error("旧图鉴 map.json 须为实体文件。");
    const directory = await realpath(exportRoot);
    const data = join(directory, "data");
    if (await realpath(data) !== data) throw new Error("旧图鉴 data 须为原导出目录下的实体目录。");
    sources.add(directory);
  }
  if (sources.size > 1) throw new LegacyAtlasSourceConflict();
  return sources.values().next().value;
}

export async function discoverRuntimeAtlasDataDirectory(atlasRoot: string) {
  // An existing primary marker owns the selection, even when it cannot be read.
  if (await lstatIfPresent(join(atlasRoot, "current")) || await lstatIfPresent(join(atlasRoot, "data"))) {
    return { ...await discoverAtlasDataDirectory(atlasRoot), legacy: false };
  }
  const source = await findLegacyAtlasExport(atlasRoot);
  if (source) return { root: join(source, "data"), version: null, legacy: true };
  return { ...await discoverAtlasDataDirectory(atlasRoot), legacy: false };
}


// A theme and the publication lock are independent of the Atlas data itself.
export async function atlasRootIsEmpty(root: string): Promise<boolean> {
  const directory = resolve(root);
  for (let candidate = directory; ; candidate = dirname(candidate)) {
    const info = await lstatIfPresent(candidate);
    if (!info) continue;
    if (!info.isDirectory() || await realpath(candidate) !== candidate) return false;
    break;
  }
  if (await findLegacyAtlasExport(directory)) return false;
  if (!await lstatIfPresent(directory)) return true;

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "theme" && entry.isDirectory()) continue;
    // BEGIN IMMEDIATE may create the rollback journal while the publication lock is held.
    if ((entry.name === ".publication.sqlite" || entry.name === ".publication.sqlite-journal") && entry.isFile()) continue;
    if (entry.name !== "snapshots" || !entry.isDirectory() || (await readdir(join(directory, entry.name))).length) {
      return false;
    }
  }
  return true;
}
