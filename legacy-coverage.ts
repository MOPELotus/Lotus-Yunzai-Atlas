import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { acquireLegacyAtlasIndexes } from "./acquire-legacy-indexes.ts";
import { acquireLegacyAtlasRecord } from "./acquire-legacy-record.ts";
import { candidateFile } from "./candidate-gallery.ts";
import { legacyAtlasRecordSources } from "./legacy-record-source-profile.ts";
import { legacyAtlasCounts, legacyAtlasSourcePages } from "./legacy-source-profile.ts";
import { atlasSourceOrigin } from "./source-transport.ts";
import { object } from "./source-values.ts";
import { validateAtlasCandidate } from "./validate-candidate.ts";

const placeholderPath = "gallery/_placeholder/unknown.svg";
const legacyPlaceholderReferences = 140;
const legacyPlaceholderSha256 = "25fe1ba8bf237af8dc0157859efb518fa04c23b8e55ca4c05ec8292eebc2122e";
const hsrDetailDirs: Readonly<Record<string, string>> = { maze_boss: "boss", maze_peak: "peak", maze_extra: "story" };

interface DirectArtwork {
  readonly path: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

interface ArtworkReference extends DirectArtwork {
  readonly fieldPath: string;
  readonly originalValue: string;
}

interface ExportRecord {
  readonly itemPath: string;
  readonly detailUrl?: string;
  readonly artwork: readonly ArtworkReference[];
  readonly placeholderReferences: number;
}

function coverage(expected: number, pinned: number, verified: number) {
  return { expected, pinned, verified, missing: expected - verified };
}

/** Match the same source and destination, even when different files happen to have identical bytes. */
function matchLegacyArtwork(original: DirectArtwork, pinned: DirectArtwork) {
  return original.path === pinned.path && original.url === pinned.url && original.sha256 === pinned.sha256 && original.bytes === pinned.bytes;
}

function directArtwork(value: unknown, game: string): ArtworkReference {
  const { localPath, remoteUrl, sha256, bytes, status, placeholder, fieldPath, originalValue } = object(value);
  if (status !== "downloaded" || placeholder !== false || typeof localPath !== "string" ||
      !localPath.startsWith(`gallery/${game}/`) || /[\\\p{Cc}]/u.test(localPath) ||
      localPath.split("/").some((part) => part === "." || part === ".." || !part) ||
      typeof remoteUrl !== "string" || !remoteUrl.startsWith(`${atlasSourceOrigin}/assets/${game}/`) || /[#?\\\p{Cc}]/u.test(remoteUrl) ||
      typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256) || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0 ||
      typeof fieldPath !== "string" || !fieldPath || typeof originalValue !== "string") {
    throw new Error("旧导出含无效原图引用。");
  }
  return { path: localPath, url: remoteUrl, sha256, bytes, fieldPath, originalValue };
}

async function readInventory(root: string, signal?: AbortSignal) {
  const data = await realpath(join(root, "data"));
  const validation = await validateAtlasCandidate(data, legacyAtlasSourcePages, signal);
  if (!validation.ok || validation.pages.length !== legacyAtlasSourcePages.length) {
    throw new Error(`旧导出与核实的 29 类目录不同。${validation.issues[0] ?? ""}`);
  }
  const index = object(JSON.parse(await readFile(await candidateFile(data, "map.json"), "utf8")));
  const expectedFiles = new Map<string, DirectArtwork>();
  const expectedByUrl = new Map<string, DirectArtwork>();
  const pages = new Map<string, ReadonlyMap<string, ExportRecord>>();
  for (const { game, pageId, version, indexPath } of legacyAtlasSourcePages) {
    const locale = object(object(object(object(index.games)[game]).locales).zh);
    const page = object(object(locale.pages)[pageId]);
    if (page.sourceUrl !== `${atlasSourceOrigin}${indexPath}`) throw new Error(`旧导出索引来源不同（${game}/${pageId}）。`);
    const records = new Map<string, ExportRecord>();
    for (const [id, row] of Object.entries(object(page.records))) {
      signal?.throwIfAborted();
      const path = object(row).path;
      if (typeof path !== "string" || !path.startsWith("items/")) throw new Error(`旧导出条目路径无效（${game}/${pageId}/${id}）。`);
      const meta = object(object(JSON.parse(await readFile(await candidateFile(data, path), "utf8"))).meta);
      const detailDir = game === "hsr" ? hsrDetailDirs[pageId] ?? pageId : pageId;
      const detailUrl = meta.hasDetail === true ? `${atlasSourceOrigin}/${game}/${version}/zh/${detailDir}/${id}.json` : undefined;
      if (detailUrl && meta.detailSourceUrl !== detailUrl) throw new Error(`旧导出详情来源不同（${game}/${pageId}/${id}）。`);
      if (!Array.isArray(meta.images)) throw new Error(`旧导出缺少原图引用清单（${game}/${pageId}/${id}）。`);
      const artwork: ArtworkReference[] = [];
      let placeholderReferences = 0;
      for (const entry of meta.images) {
        const row = object(entry);
        if (row.placeholder === true) {
          if (row.status !== "placeholder" || row.localPath !== placeholderPath || row.remoteUrl !== null ||
              row.sha256 !== legacyPlaceholderSha256) {
            throw new Error("旧导出含无效占位图引用。");
          }
          placeholderReferences++;
          continue;
        }
        const art = directArtwork(row, game);
        const existing = expectedFiles.get(art.path) ?? expectedByUrl.get(art.url);
        if (existing && !matchLegacyArtwork(existing, art)) throw new Error(`旧导出原图身份冲突（${art.path}）。`);
        expectedFiles.set(art.path, art);
        expectedByUrl.set(art.url, art);
        artwork.push(art);
      }
      records.set(id, { itemPath: `data/${path}`, detailUrl, artwork, placeholderReferences });
    }
    pages.set(`${game}/${pageId}`, records);
  }
  const records = [...pages.values()].flatMap((page) => [...page.values()]);
  const details = records.filter(({ detailUrl }) => detailUrl !== undefined).length;
  const placeholders = records.reduce((sum, record) => sum + record.placeholderReferences, 0);
  if (details !== legacyAtlasCounts.detailCount || placeholders !== legacyPlaceholderReferences ||
      expectedFiles.size + 1 !== legacyAtlasCounts.imageCount) throw new Error("旧导出的详情或图库引用总数与核实版本不同。");
  return { pages, details, placeholders, expectedFiles };
}

export async function reportLegacyAtlasCoverage(exportRoot: string, cache: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!(await lstat(cache)).isDirectory()) throw new Error("请指定已有的原响应检查点目录。");
  const inventory = await readInventory(exportRoot, signal);
  const indexes = await acquireLegacyAtlasIndexes(cache, { maxRequests: 0, signal });
  const pinnedDetails = new Set<string>();
  const verifiedDetails = new Set<string>();
  const pinnedArtwork = new Set<string>();
  const verifiedArtwork = new Set<string>();
  const mappedRecords = [];
  for (const [key, record] of Object.entries(legacyAtlasRecordSources)) {
    const { game, pageId, recordId, detail: [detailPath, detailSha256, bytes], artwork } = record;
    const expected = inventory.pages.get(`${game}/${pageId}`)?.get(recordId);
    const detailUrl = `${atlasSourceOrigin}${detailPath}`;
    if (expected?.detailUrl !== detailUrl) throw new Error(`旧条目与固定详情不符（${key}）。`);
    const original = new Set(expected.artwork.map(({ path }) => path));
    const capture = await acquireLegacyAtlasRecord(cache, key, { maxRequests: 0, signal });
    const cached = new Set(capture.files.filter(({ state }) => state === "cached").map(({ sourcePath }) => sourcePath));
    pinnedDetails.add(key);
    if (cached.has(detailPath)) verifiedDetails.add(key);
    const mappedArtwork = artwork.map(([path, galleryPath, sha256, bytes]) => {
      const image = { path: galleryPath, url: `${atlasSourceOrigin}${path}`, sha256, bytes };
      const originalImage = inventory.expectedFiles.get(galleryPath);
      if (!original.has(galleryPath) || !originalImage || !matchLegacyArtwork(image, originalImage)) {
        throw new Error(`旧原图引用与固定来源不同（${key}/${galleryPath}）。`);
      }
      const verified = cached.has(path);
      pinnedArtwork.add(galleryPath);
      if (verified) verifiedArtwork.add(galleryPath);
      return { ...image, checkpoint: `${sha256}.blob`, verified, references: expected.artwork.filter(({ path }) => path === galleryPath)
        .map(({ fieldPath, originalValue }) => ({ fieldPath, originalValue })) };
    });
    mappedRecords.push({ key, itemPath: expected.itemPath, detail: { url: detailUrl, sha256: detailSha256, bytes,
      checkpoint: `${detailSha256}.blob`, contentField: "content.detail", verified: cached.has(detailPath) },
      artwork: mappedArtwork, directArtworkReferences: expected.artwork.length, placeholders: expected.placeholderReferences });
  }

  const pages = indexes.pages.map(({ game, pageId, version, state, url, sha256, recordCount }) => {
    const prefix = `${game}/${pageId}`;
    const records = inventory.pages.get(prefix)!;
    const details = [...records].flatMap(([id, record]) => record.detailUrl ? [`${prefix}/${id}`] : []);
    const images = [...records.values()].flatMap(({ artwork }) => artwork);
    const paths = [...new Set(images.map(({ path }) => path))];
    const placeholders = [...records.values()].reduce((sum, record) => sum + record.placeholderReferences, 0);
    const verifiedReferences = images.filter(({ path }) => verifiedArtwork.has(path)).length;
    return { game, pageId, version, recordCount, index: { url, sha256, verified: state === "cached" },
      details: coverage(details.length, details.filter((key) => pinnedDetails.has(key)).length, details.filter((key) => verifiedDetails.has(key)).length),
      artwork: { ...coverage(paths.length, paths.filter((path) => pinnedArtwork.has(path)).length,
        paths.filter((path) => verifiedArtwork.has(path)).length), references: images.length, verifiedReferences, placeholders } };
  });
  const references = pages.reduce((sum, page) => sum + page.artwork.references, 0);
  const verifiedReferences = pages.reduce((sum, page) => sum + page.artwork.verifiedReferences, 0);
  return {
    layout: { map: "data/map.json", items: "data/items", gallery: "gallery", placeholder: placeholderPath },
    inventoryOrigin: "local-legacy-export",
    verifiedOrigin: "pinned-public-response-checkpoints",
    indexes: coverage(pages.length, pages.length, pages.filter(({ index }) => index.verified).length),
    records: { expected: pages.reduce((sum, page) => sum + page.recordCount, 0), indexed: indexes.verifiedRecordCount },
    details: coverage(inventory.details, pinnedDetails.size, verifiedDetails.size),
    artwork: { ...coverage(inventory.expectedFiles.size, pinnedArtwork.size, verifiedArtwork.size), references, verifiedReferences },
    placeholders: { references: inventory.placeholders, sharedFiles: 1, expectedSha256: legacyPlaceholderSha256 },
    pages, mappedRecords,
  } as const;
}

if (import.meta.main) {
  const [source, cache, ...extra] = Bun.argv.slice(2);
  if (!source || !cache || extra.length) {
    console.error("用法：bun legacy-coverage.ts <原本地导出根目录> <已有原响应检查点目录>");
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(await reportLegacyAtlasCoverage(source, cache), null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "无法核对图鉴准备覆盖范围。");
      process.exitCode = 1;
    }
  }
}
