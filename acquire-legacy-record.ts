import { createHash } from "node:crypto";
import { matchesLegacyAtlasIndex, maxLegacyAtlasIndexBytes } from "./audit-legacy-source.ts";
import { legacyAtlasRecordSources, type LegacyAtlasRecordKey } from "./legacy-record-source-profile.ts";
import { legacyAtlasSourcePages } from "./legacy-source-profile.ts";
import { openAtlasPinnedCache } from "./pinned-source-cache.ts";
import { atlasSourceOrigin, isAtlasSourceWebp, readAtlasSourceBytes, type AtlasSourceFetch } from "./source-transport.ts";

type FileState = "cached" | "downloaded" | "pending" | "request-failed" | "content-mismatch";
const utf8 = new TextDecoder("utf-8", { fatal: true });

function recordKey(key: string): key is LegacyAtlasRecordKey {
  return Object.hasOwn(legacyAtlasRecordSources, key);
}

function detailObject(bytes: Buffer): boolean {
  try {
    const value: unknown = JSON.parse(utf8.decode(bytes));
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

/** Stage pinned files for one audited record, using the independently verified index checkpoint. */
export async function acquireLegacyAtlasRecord(workspace: string, key: string, { request = fetch, signal, maxRequests }: {
  readonly request?: AtlasSourceFetch;
  readonly signal?: AbortSignal;
  readonly maxRequests?: number;
} = {}) {
  signal?.throwIfAborted();
  if (!recordKey(key)) throw new Error("这条图鉴记录尚无核实的固定详情和原图文件清单。");
  const { game, pageId, recordId, detail, artwork } = legacyAtlasRecordSources[key];
  const page = legacyAtlasSourcePages.find((entry) => entry.game === game && entry.pageId === pageId);
  if (!page) throw new Error("图鉴固定详情缺少对应版本索引。");
  const [sourcePath, sha256, bytes] = detail;
  const descriptors = [{ sourcePath, sha256, bytes, kind: "detail" as const, galleryPath: undefined },
    ...artwork.map(([sourcePath, galleryPath, sha256, bytes]) => ({ sourcePath, sha256, bytes, kind: "artwork" as const, galleryPath }))];
  const limit = maxRequests ?? descriptors.length;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > descriptors.length) {
    throw new Error(`此图鉴记录的请求次数须在 0 到 ${descriptors.length} 之间。`);
  }

  const cache = await openAtlasPinnedCache(workspace);
  const index = await cache.read(page.indexSha256, maxLegacyAtlasIndexBytes, signal);
  const location = { record: key, version: page.version, directory: cache.directory } as const;
  if (!index || !matchesLegacyAtlasIndex(page, index) || !Object.hasOwn(JSON.parse(utf8.decode(index)), recordId)) {
    return { ...location, status: "index-required", requests: 0, files: [] } as const;
  }

  let requests = 0;
  const files = [];
  for (const descriptor of descriptors) {
    signal?.throwIfAborted();
    const url = `${atlasSourceOrigin}${descriptor.sourcePath}`;
    const detail = descriptor.kind === "detail";
    const matchesShape = detail ? detailObject : isAtlasSourceWebp;
    const saved = await cache.read(descriptor.sha256, descriptor.bytes, signal);
    let state: FileState = "pending";
    if (saved?.length === descriptor.bytes && matchesShape(saved)) state = "cached";
    else if (requests < limit) {
      requests++;
      const bytes = await readAtlasSourceBytes(url, detail ? "application/json" : "image/webp", descriptor.bytes,
        false, signal, request).catch(() => undefined);
      signal?.throwIfAborted();
      if (!bytes) state = "request-failed";
      else if (bytes.length !== descriptor.bytes || !matchesShape(bytes) || createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256) {
        state = "content-mismatch";
      } else {
        await cache.write(descriptor.sha256, bytes, signal);
        state = "downloaded";
      }
    }
    files.push({ ...descriptor, url, state });
  }
  const complete = files.every(({ state }) => state === "downloaded" || state === "cached");
  return { ...location, status: complete ? "record-files-ready" : "incomplete", requests, files } as const;
}

if (import.meta.main) {
  const [workspace, key, option, value, ...extra] = Bun.argv.slice(2);
  if (!workspace || !key || extra.length || (option !== undefined && (option !== "--max-requests" || !value || !/^\d+$/u.test(value)))) {
    console.error(`用法：bun acquire-legacy-record.ts <原索引检查点目录> <${Object.keys(legacyAtlasRecordSources).join("|")}> [--max-requests 次数]`);
    process.exitCode = 2;
  } else {
    try {
      const report = await acquireLegacyAtlasRecord(workspace, key, { maxRequests: value === undefined ? undefined : Number(value) });
      console.log(JSON.stringify(report, null, 2));
      if (report.status !== "record-files-ready") process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : "图鉴记录文件准备失败。");
      process.exitCode = 1;
    }
  }
}
