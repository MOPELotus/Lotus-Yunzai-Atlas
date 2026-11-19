import { lstat } from "node:fs/promises";
import { matchesLegacyAtlasIndex, maxLegacyAtlasIndexBytes } from "./audit-legacy-source.ts";
import { readLegacyExportInventory } from "./legacy-coverage.ts";
import { legacyAtlasRecordSources } from "./legacy-record-source-profile.ts";
import { legacyAtlasSourcePages } from "./legacy-source-profile.ts";
import { openAtlasPinnedCache } from "./pinned-source-cache.ts";
import { atlasSourceOrigin } from "./source-transport.ts";
import { object } from "./source-values.ts";

const utf8 = new TextDecoder("utf-8", { fatal: true });
const bytePinned = new Map(Object.entries(legacyAtlasRecordSources));

export interface LegacyDetailQueueEntry {
  readonly key: string;
  readonly version: string;
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly itemPath: string;
  readonly state: "byte-pinned" | "eligible-candidate" | "identity-review";
}

/** Require all fixed indexes and compare every original record key before deriving network work. */
export async function planLegacyDetailQueue(exportRoot: string, cache: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!(await lstat(cache)).isDirectory()) throw new Error("请指定已有的图鉴索引检查点目录。");
  const checkpoints = await openAtlasPinnedCache(cache);
  const sources = new Map<string, Record<string, unknown>>();
  for (const page of legacyAtlasSourcePages) {
    const bytes = await checkpoints.read(page.indexSha256, maxLegacyAtlasIndexBytes, signal);
    if (!bytes || !matchesLegacyAtlasIndex(page, bytes)) throw new Error(`图鉴索引未验证（${page.game}/${page.pageId}）。`);
    sources.set(`${page.game}/${page.pageId}`, JSON.parse(utf8.decode(bytes)) as Record<string, unknown>);
  }
  const inventory = await readLegacyExportInventory(exportRoot, signal);
  const entries: LegacyDetailQueueEntry[] = [];
  for (const { game, pageId, version } of legacyAtlasSourcePages) {
    const prefix = `${game}/${pageId}`;
    const original = inventory.pages.get(prefix)!;
    const source = sources.get(prefix)!;
    if (Object.keys(source).length !== original.size || [...original.keys()].some((id) => !Object.hasOwn(source, id))) {
      throw new Error(`旧导出记录 ID 与固定索引不同（${prefix}）。`);
    }
    for (const [id, { detailUrl, itemPath, name, exactDetailIdentity }] of original) {
      signal?.throwIfAborted();
      if (!detailUrl) continue;
      const key = `${prefix}/${id}`;
      let state: LegacyDetailQueueEntry["state"] = "identity-review";
      const pinned = bytePinned.get(key);
      if (pinned) {
        if (`${atlasSourceOrigin}${pinned.detail[0]}` !== detailUrl) throw new Error(`旧导出详情来源与固定字节清单不同（${key}）。`);
        state = "byte-pinned";
      }
      else if (prefix === "hsr/maze_boss" && exactDetailIdentity && object(source[id]).zh === name) state = "eligible-candidate";
      entries.push({ key, version, id, name, url: detailUrl, itemPath, state });
    }
  }
  return {
    entries,
    totals: {
      detailFiles: entries.length,
      bytePinned: entries.filter(({ state }) => state === "byte-pinned").length,
      eligibleCandidate: entries.filter(({ state }) => state === "eligible-candidate").length,
      identityReview: entries.filter(({ state }) => state === "identity-review").length,
    },
  } as const;
}

if (import.meta.main) {
  const [source, cache, ...extra] = Bun.argv.slice(2);
  if (!source || !cache || extra.length) {
    console.error("用法：bun legacy-detail-queue.ts <原本地导出根目录> <已有原索引检查点目录>");
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(await planLegacyDetailQueue(source, cache), null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "无法生成图鉴详情队列。");
      process.exitCode = 1;
    }
  }
}
