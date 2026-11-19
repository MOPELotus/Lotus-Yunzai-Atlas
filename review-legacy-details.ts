import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { matchesLegacyAtlasIndex, maxLegacyAtlasIndexBytes } from "./audit-legacy-source.ts";
import { readLegacyDetailCandidate } from "./capture-legacy-details.ts";
import { candidateFile } from "./candidate-gallery.ts";
import { readLegacyExportInventory } from "./legacy-coverage.ts";
import { planLegacyDetailQueue } from "./legacy-detail-queue.ts";
import { compareLegacyJsonEvidence, evidenceObject, legacyEvidenceDigest, parseLegacyJsonEvidence } from "./legacy-json-evidence.ts";
import { legacyAtlasSourcePages } from "./legacy-source-profile.ts";
import { openAtlasPinnedCache } from "./pinned-source-cache.ts";

const utf8 = new TextDecoder("utf-8", { fatal: true });

async function oldContent(data: string, itemPath: string) {
  const json = parseLegacyJsonEvidence(utf8.decode(await readFile(await candidateFile(data, itemPath.slice("data/".length)))));
  return evidenceObject(evidenceObject(json).content ?? null);
}

/** Return evidence only. Even matching candidate bytes are never added to independent source coverage here. */
export async function reviewLegacyDetail(exportRoot: string, cache: string, key: string, checkpoint: string, signal?: AbortSignal) {
  const queue = await planLegacyDetailQueue(exportRoot, cache, signal);
  const entry = queue.entries.find((item) => item.key === key && item.state === "eligible-candidate");
  if (!entry) throw new Error("图鉴详情没有可独立复核的候选身份。");
  const { body, sha256, bytes } = await readLegacyDetailCandidate(entry, checkpoint, signal);
  const old = (await oldContent(await realpath(join(exportRoot, "data")), entry.itemPath)).detail;
  if (!old) throw new Error("旧导出没有对应的嵌入详情。");
  const detail = parseLegacyJsonEvidence(utf8.decode(body));
  const comparison = compareLegacyJsonEvidence(old, detail);
  return { key, url: entry.url, version: entry.version, itemPath: entry.itemPath,
    old: { canonicalSha256: legacyEvidenceDigest(old) }, candidate: { rawSha256: sha256, bytes }, ...comparison } as const;
}

/** Show complete list-only classes without increasing the number of independently fixed detail files. */
export async function reviewLegacyIndexedOnly(exportRoot: string, cache: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!(await lstat(cache)).isDirectory()) throw new Error("请指定已有的图鉴索引检查点目录。");
  const checkpoints = await openAtlasPinnedCache(cache);
  const inventory = await readLegacyExportInventory(exportRoot, signal);
  const data = await realpath(join(exportRoot, "data"));
  const pages = [];
  for (const page of legacyAtlasSourcePages) {
    signal?.throwIfAborted();
    const { game, pageId, version, indexSha256 } = page;
    const records = inventory.pages.get(`${game}/${pageId}`)!;
    if ([...records.values()].some(({ detailUrl }) => detailUrl !== undefined)) continue;
    const bytes = await checkpoints.read(indexSha256, maxLegacyAtlasIndexBytes, signal);
    if (!bytes || !matchesLegacyAtlasIndex(page, bytes)) {
      pages.push({ game, pageId, version, indexSha256, records: records.size, exactRows: 0, status: "index-unverified" });
      continue;
    }
    const raw = parseLegacyJsonEvidence(utf8.decode(bytes));
    const indexed = Array.isArray(raw) ? Object.fromEntries(raw.map((row, index) => [String(index), row])) : evidenceObject(raw);
    let exactRows = 0;
    for (const [id, { itemPath }] of records) {
      signal?.throwIfAborted();
      const { list } = await oldContent(data, itemPath);
      if (list !== undefined && Object.hasOwn(indexed, id) && compareLegacyJsonEvidence(list, indexed[id]!).status === "exact") exactRows++;
    }
    pages.push({ game, pageId, version, indexSha256, records: records.size, exactRows, status: exactRows === records.size ? "exact" : "different" });
  }
  return { pages, totals: { pages: pages.length, exactPages: pages.filter(({ status }) => status === "exact").length,
    records: pages.reduce((sum, page) => sum + page.records, 0), exactRows: pages.reduce((sum, page) => sum + page.exactRows, 0) } } as const;
}

if (import.meta.main) {
  const [source, cache, selector, checkpoint, ...extra] = Bun.argv.slice(2);
  if (!source || !cache || !selector || extra.length || (selector === "--indexed-only" ? checkpoint !== undefined : !checkpoint)) {
    console.error("用法：bun review-legacy-details.ts <原导出根> <原索引检查点目录> <条目键 候选文件 | --indexed-only>");
    process.exitCode = 2;
  } else {
    try {
      const report = selector === "--indexed-only" ? await reviewLegacyIndexedOnly(source, cache)
        : await reviewLegacyDetail(source, cache, selector, checkpoint!);
      console.log(JSON.stringify(report, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "无法复核图鉴原详情。");
      process.exitCode = 1;
    }
  }
}
