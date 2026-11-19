import { mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { copyAtlasCandidate } from "./assemble-candidate.ts";
import { atlasApplyStagingPrefix, hasLegacyAtlasData, publishPreparedAtlasCandidate, readAtlasSnapshotVersion,
  type AtlasPublication } from "./publish-candidate.ts";
import { legacyAtlasCounts, legacyAtlasSourcePages } from "./legacy-source-profile.ts";

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return !isAbsolute(path) && path.split(sep)[0] !== "..";
}

/** Initialize once from an operator-supplied local export. Existing data and published snapshots are never replaced. */
export async function initializeAtlas(root: string, source: string, signal?: AbortSignal): Promise<AtlasPublication> {
  signal?.throwIfAborted();
  if ([root, source].some((path) => !path.trim() || /^[a-z][a-z0-9+.-]*:\/\//iu.test(path))) {
    throw new Error("请提供已有的本地图鉴目标目录和原导出目录。");
  }
  const [directory, donor] = await Promise.all([realpath(root), realpath(source)]);
  if (contains(directory, donor) || contains(donor, directory)) throw new Error("图鉴目标和原导出必须是独立目录。");
  const current = await readAtlasSnapshotVersion(directory);
  if (current !== null) return { status: "stale", current };
  if (await hasLegacyAtlasData(directory)) return { status: "invalid", issues: ["图鉴已有旧版 data，首版初始化未执行。"] };
  const stage = await mkdtemp(join(dirname(directory), atlasApplyStagingPrefix));
  let result: AtlasPublication | undefined;
  try {
    const prepared = await copyAtlasCandidate(donor, join(stage, "candidate"), legacyAtlasSourcePages, legacyAtlasCounts, signal);
    result = await publishPreparedAtlasCandidate(directory, null, prepared.directory, prepared.validation.pages, signal, true);
    return result;
  } finally {
    if (result?.status !== "published") await rm(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [root, source, ...extra] = Bun.argv.slice(2);
  if (!root || !source || extra.length) {
    console.error("用法：bun initialize-atlas.ts <已有的本地图鉴目标目录> <包含 data/map.json 和 gallery/ 的原图鉴导出目录>");
    process.exitCode = 2;
  } else {
    try {
      const result = await initializeAtlas(root, source);
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "published") process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : "无法从本地原图鉴导出初始化。");
      process.exitCode = 1;
    }
  }
}
