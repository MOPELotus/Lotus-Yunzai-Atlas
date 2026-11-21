import { mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { assembleAtlasCandidate, copyAtlasCandidate } from "./assemble-candidate.ts";
import { atlasApplyStagingPrefix, hasLegacyAtlasData, publishPreparedAtlasCandidate, readAtlasSnapshotVersion,
  type AtlasPublication } from "./publish-candidate.ts";
import { findLegacyAtlasExport } from "./legacy-atlas-directory.ts";
import { legacyAtlasCounts, legacyAtlasSourcePages } from "./legacy-source-profile.ts";
import { atlasManifestVersion, fetchAtlasManifest, type AtlasVersionChannel } from "./update-plan.ts";
import { acquireAtlasSource } from "./source-acquisition.ts";
import type { AtlasSourceFetch } from "./source-transport.ts";
import type { AtlasCandidatePage } from "./validate-candidate.ts";

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return !isAbsolute(path) && path.split(sep)[0] !== "..";
}

/** Initialize once from an operator-supplied local export. Existing data and published snapshots are never replaced. */
export async function initializeAtlas(root: string, source: string, signal?: AbortSignal): Promise<AtlasPublication> {
  return publishInitialAtlas(root, source, legacyAtlasSourcePages, legacyAtlasCounts, signal);
}

async function publishInitialAtlas(root: string, source: string, pages: readonly Required<AtlasCandidatePage>[],
  counts: typeof legacyAtlasCounts | undefined, signal?: AbortSignal,
  extra?: { readonly source: string; readonly pages: readonly Required<AtlasCandidatePage>[] },
  materialRequest?: AtlasSourceFetch): Promise<AtlasPublication> {
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
    const target = join(stage, "candidate");
    const prepared = extra
      ? await assembleAtlasCandidate(donor, extra.source, target, extra.pages, signal)
      : await copyAtlasCandidate(donor, target, pages, counts, signal);
    if (materialRequest) {
      const { completeAtlasRoleMaterials } = await import("./role-material-source.ts");
      await completeAtlasRoleMaterials(prepared.directory, pages, signal, materialRequest);
    }
    const expected = extra ? [...pages, ...extra.pages] : pages;
    result = await publishPreparedAtlasCandidate(directory, null, prepared.directory, expected, signal, true);
    return result;
  } finally {
    if (result?.status !== "published") await rm(stage, { recursive: true, force: true });
  }
}

export async function initializeAtlasFromPublic(root: string, workspace: string, signal?: AbortSignal,
  channel?: AtlasVersionChannel, { manifest = fetchAtlasManifest, request }:
  { readonly manifest?: typeof fetchAtlasManifest; readonly request?: AtlasSourceFetch } = {}): Promise<AtlasPublication> {
  signal?.throwIfAborted();
  const current = await readAtlasSnapshotVersion(root);
  if (current !== null) return { status: "stale", current };
  if (await hasLegacyAtlasData(root)) return { status: "invalid", issues: ["图鉴已有旧版 data，首版初始化未执行。"] };
  const { downloadLegacyAtlas, downloadAtlasVersion } = await import("./download-legacy-atlas.ts");
  if (channel) {
    const listing = await manifest(signal);
    const gi = atlasManifestVersion(listing, "gi", channel);
    const hsr = atlasManifestVersion(listing, "hsr", channel);
    const zzz = atlasManifestVersion(listing, "zzz", channel);
    if (!gi || !hsr || !zzz) throw new Error("原站清单未列出三款游戏所选的图鉴版本。");
    const directory = await realpath(root);
    return downloadAtlasVersion(workspace, directory, { gi, hsr, zzz }, async (donor, pages) => {
      const stage = await mkdtemp(join(dirname(directory), ".atlas-first-gcg-"));
      try {
        const cards = await acquireAtlasSource(join(stage, "source"), [{ game: "gi", pageId: "gcg", version: gi }], signal, request);
        return await publishInitialAtlas(directory, donor, pages, undefined, signal, { source: cards.directory, pages: cards.pages });
      } finally {
        await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      }
    }, signal, request);
  }
  return downloadLegacyAtlas(workspace, root,
    donor => publishInitialAtlas(root, donor, legacyAtlasSourcePages, legacyAtlasCounts, signal, undefined, request ?? fetch), signal);
}

if (import.meta.main) {
  const [root, mode, workspace, ...extra] = Bun.argv.slice(2);
  const publicData = mode === "--public";
  const [flag, channel] = extra;
  const chosenChannel = publicData && extra.length === 2 && flag === "--channel" && (channel === "live" || channel === "latest");
  if (!root || (extra.length && !chosenChannel) || (publicData ? !workspace : workspace !== undefined)) {
    console.error("用法：bun initialize-atlas.ts <本地图鉴目标目录> [已有原导出目录 | --public 下载工作目录 [--channel live|latest]]");
    process.exitCode = 2;
  } else {
    const controller = new AbortController();
    const stop = () => controller.abort(new Error("图鉴初始化已中止，下载工作目录已保留。"));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      let result: AtlasPublication;
      if (publicData) {
        result = await initializeAtlasFromPublic(root, workspace!, controller.signal, chosenChannel ? channel as AtlasVersionChannel : undefined);
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
