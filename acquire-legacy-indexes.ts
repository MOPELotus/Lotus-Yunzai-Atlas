import { matchesLegacyAtlasIndex, maxLegacyAtlasIndexBytes } from "./audit-legacy-source.ts";
import { legacyAtlasSourcePages } from "./legacy-source-profile.ts";
import { openAtlasPinnedCache } from "./pinned-source-cache.ts";
import { atlasSourceOrigin, readAtlasSourceBytes, type AtlasSourceFetch } from "./source-transport.ts";
import { object } from "./source-values.ts";
import { fetchAtlasManifest } from "./update-plan.ts";

type CheckpointState = "cached" | "downloaded" | "pending" | "version-unavailable" | "request-failed" | "content-mismatch";

/** Acquire fixed original indexes only. This cache is not a runtime snapshot. */
export async function acquireLegacyAtlasIndexes(workspace: string, {
  manifest = fetchAtlasManifest, request = fetch, signal, maxRequests = legacyAtlasSourcePages.length,
}: {
  readonly manifest?: typeof fetchAtlasManifest;
  readonly request?: AtlasSourceFetch;
  readonly signal?: AbortSignal;
  readonly maxRequests?: number;
} = {}) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 0 || maxRequests > legacyAtlasSourcePages.length) {
    throw new Error(`图鉴索引请求次数须在 0 到 ${legacyAtlasSourcePages.length} 之间。`);
  }
  const cache = await openAtlasPinnedCache(workspace);
  let requests = 0;
  let listing: Promise<unknown> | undefined;
  const pages = [];
  for (const page of legacyAtlasSourcePages) {
    signal?.throwIfAborted();
    const { game, pageId, version, recordCount, indexSha256, indexPath } = page;
    const url = `${atlasSourceOrigin}${indexPath}`;
    const saved = await cache.read(indexSha256, maxLegacyAtlasIndexBytes, signal);
    let state: CheckpointState = "pending";
    if (saved && matchesLegacyAtlasIndex(page, saved)) state = "cached";
    else if (requests < maxRequests) {
      listing ??= manifest(signal).catch(() => undefined);
      const { available } = object(object(await listing)[game]);
      signal?.throwIfAborted();
      if (!Array.isArray(available) || !available.includes(version)) state = "version-unavailable";
      else {
        requests++;
        const bytes = await readAtlasSourceBytes(url, "application/json", maxLegacyAtlasIndexBytes, false, signal, request)
          .catch(() => undefined);
        signal?.throwIfAborted();
        if (!bytes) state = "request-failed";
        else if (!matchesLegacyAtlasIndex(page, bytes)) state = "content-mismatch";
        else {
          await cache.write(indexSha256, bytes, signal);
          state = "downloaded";
        }
      }
    }
    pages.push({ game, pageId, version, recordCount, url, sha256: indexSha256, state });
  }
  const verified = pages.filter(({ state }) => state === "cached" || state === "downloaded");
  return { status: verified.length === pages.length ? "indexes-ready" : "incomplete", directory: cache.directory,
    requests, pages, verifiedRecordCount: verified.reduce((count, page) => count + page.recordCount, 0) } as const;
}

if (import.meta.main) {
  const [workspace, option, value, ...extra] = Bun.argv.slice(2);
  if (!workspace || extra.length || (option !== undefined && (option !== "--max-requests" || !value || !/^\d+$/u.test(value)))) {
    console.error("用法：bun acquire-legacy-indexes.ts <独立本地目录> [--max-requests 0至29]");
    process.exitCode = 2;
  } else {
    try {
      const report = await acquireLegacyAtlasIndexes(workspace, { maxRequests: value === undefined ? undefined : Number(value) });
      console.log(JSON.stringify(report, null, 2));
      if (report.status !== "indexes-ready") process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : "图鉴固定索引准备失败。");
      process.exitCode = 1;
    }
  }
}
