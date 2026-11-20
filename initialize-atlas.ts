import { mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { copyAtlasCandidate } from "./assemble-candidate.ts";
import { atlasApplyStagingPrefix, hasLegacyAtlasData, publishPreparedAtlasCandidate, readAtlasSnapshotVersion,
  type AtlasPublication } from "./publish-candidate.ts";
import { findLegacyAtlasExport } from "./legacy-atlas-directory.ts";
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
  const [root, mode, workspace, ...extra] = Bun.argv.slice(2);
  const publicData = mode === "--public";
  if (!root || extra.length || (publicData ? !workspace : workspace !== undefined)) {
    console.error("用法：bun initialize-atlas.ts <本地图鉴目标目录> [已有原导出目录 | --public 下载工作目录]");
    process.exitCode = 2;
  } else {
    const controller = new AbortController();
    const stop = () => controller.abort(new Error("图鉴初始化已中止，下载工作目录已保留。"));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      let result: AtlasPublication;
      if (publicData) {
        const current = await readAtlasSnapshotVersion(root);
        if (current !== null) result = { status: "stale", current };
        else if (await hasLegacyAtlasData(root)) result = { status: "invalid", issues: ["图鉴已有旧版 data，首版初始化未执行。"] };
        else {
          const { downloadLegacyAtlas } = await import("./download-legacy-atlas.ts");
          result = await downloadLegacyAtlas(workspace!, root,
            donor => initializeAtlas(root, donor, controller.signal), controller.signal);
        }
      } else {
        const donor = mode ?? await findLegacyAtlasExport(root);
        if (!donor) throw new Error("未找到旧图鉴导出，请指定包含 data/map.json 和 gallery/ 的原目录。");
        result = await initializeAtlas(root, donor, controller.signal);
      }
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "published") process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : "无法从原图鉴导出初始化。");
      process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
}
