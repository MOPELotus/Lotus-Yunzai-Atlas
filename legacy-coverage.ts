import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { acquireLegacyAtlasIndexes } from "./acquire-legacy-indexes.ts";
import { acquireLegacyAtlasRecord } from "./acquire-legacy-record.ts";
import { candidateFile } from "./candidate-gallery.ts";
import { legacyGenshinAchievementPage, readLegacyAchievementArtwork, readPinnedAchievementImage } from "./legacy-achievement-art.ts";
import { legacyAtlasRecordSources } from "./legacy-record-source-profile.ts";
import { legacyAtlasCounts, legacyAtlasSourcePages } from "./legacy-source-profile.ts";
import { openAtlasPinnedCache } from "./pinned-source-cache.ts";
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
  readonly name: string;
  readonly itemPath: string;
  readonly detailUrl?: string;
  readonly exactDetailIdentity: boolean;
  readonly artwork: readonly ArtworkReference[];
  readonly placeholderReferences: number;
}

export function hasExactLegacyDetailIdentity(value: unknown, id: string, name: string) {
  const detail = object(value);
  return name.trim().length > 0 && /^[1-9]\d{0,9}$/u.test(id) && (detail.id === id || detail.id === Number(id)) && detail.name === name;
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
    throw new Error($t("legacy-coverage.text_2bb22f4f27"));
  }
  return { path: localPath, url: remoteUrl, sha256, bytes, fieldPath, originalValue };
}

export async function readLegacyExportInventory(root: string, signal?: AbortSignal) {
  const data = await realpath(join(root, "data"));
  const validation = await validateAtlasCandidate(data, legacyAtlasSourcePages, signal);
  if (!validation.ok || validation.pages.length !== legacyAtlasSourcePages.length) {
    throw new Error($t("legacy-coverage.text_d2735a1a84", { "value1": validation.issues[0] ?? "" }));
  }
  const index = object(JSON.parse(await readFile(await candidateFile(data, "map.json"), "utf8")));
  const expectedFiles = new Map<string, DirectArtwork>();
  const expectedByUrl = new Map<string, DirectArtwork>();
  const pages = new Map<string, ReadonlyMap<string, ExportRecord>>();
  for (const { game, pageId, version, indexPath } of legacyAtlasSourcePages) {
    const locale = object(object(object(object(index.games)[game]).locales).zh);
    const page = object(object(locale.pages)[pageId]);
    if (page.sourceUrl !== `${atlasSourceOrigin}${indexPath}`) throw new Error($t("legacy-coverage.text_fc78d0c62d", { "game": game, "pageId": pageId }));
    const records = new Map<string, ExportRecord>();
    for (const [id, row] of Object.entries(object(page.records))) {
      signal?.throwIfAborted();
      const { path, name } = object(row);
      if (typeof name !== "string" || typeof path !== "string" || !path.startsWith("items/")) {
        throw new Error($t("legacy-coverage.text_b62ae1d00c", { "game": game, "pageId": pageId, "id": id }));
      }
      const item = object(JSON.parse(await readFile(await candidateFile(data, path), "utf8")));
      const meta = object(item.meta);
      const detailDir = game === "hsr" ? hsrDetailDirs[pageId] ?? pageId : pageId;
      const detailUrl = meta.hasDetail === true ? `${atlasSourceOrigin}/${game}/${version}/zh/${detailDir}/${id}.json` : undefined;
      if (detailUrl && meta.detailSourceUrl !== detailUrl) throw new Error($t("legacy-coverage.text_76ce939c70", { "game": game, "pageId": pageId, "id": id }));
      if (!Array.isArray(meta.images)) throw new Error($t("legacy-coverage.text_8ef7bf9f0f", { "game": game, "pageId": pageId, "id": id }));
      const artwork: ArtworkReference[] = [];
      let placeholderReferences = 0;
      for (const entry of meta.images) {
        const row = object(entry);
        if (row.placeholder === true) {
          if (row.status !== "placeholder" || row.localPath !== placeholderPath || row.remoteUrl !== null ||
              row.sha256 !== legacyPlaceholderSha256) {
            throw new Error($t("legacy-coverage.text_80f126a0ac"));
          }
          placeholderReferences++;
          continue;
        }
        const art = directArtwork(row, game);
        const existing = expectedFiles.get(art.path) ?? expectedByUrl.get(art.url);
        if (existing && !matchLegacyArtwork(existing, art)) throw new Error($t("legacy-coverage.text_3bd0da63bd", { "path": art.path }));
        expectedFiles.set(art.path, art);
        expectedByUrl.set(art.url, art);
        artwork.push(art);
      }
      const exactDetailIdentity = hasExactLegacyDetailIdentity(object(item.content).detail, id, name);
      records.set(id, { name, itemPath: `data/${path}`, detailUrl, exactDetailIdentity, artwork, placeholderReferences });
    }
    pages.set(`${game}/${pageId}`, records);
  }
  const records = [...pages.values()].flatMap((page) => [...page.values()]);
  const details = records.filter(({ detailUrl }) => detailUrl !== undefined).length;
  const placeholders = records.reduce((sum, record) => sum + record.placeholderReferences, 0);
  if (details !== legacyAtlasCounts.detailCount || placeholders !== legacyPlaceholderReferences ||
      expectedFiles.size + 1 !== legacyAtlasCounts.imageCount) throw new Error($t("legacy-coverage.text_c809914da2"));
  return { pages, details, placeholders, expectedFiles };
}

export async function reportLegacyAtlasCoverage(exportRoot: string, cache: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!(await lstat(cache)).isDirectory()) throw new Error($t("legacy-coverage.text_d702da97bb"));
  const inventory = await readLegacyExportInventory(exportRoot, signal);
  const indexes = await acquireLegacyAtlasIndexes(cache, { maxRequests: 0, signal });
  const pinnedDetails = new Set<string>();
  const verifiedDetails = new Set<string>();
  const pinnedArtwork = new Set<string>();
  const verifiedArtwork = new Set<string>();
  const checkpoints = await openAtlasPinnedCache(cache);
  const achievement = await readLegacyAchievementArtwork(inventory.pages.get(legacyGenshinAchievementPage)!, checkpoints, signal);
  for (const art of achievement?.assets ?? []) {
    pinnedArtwork.add(art.path);
    if (await readPinnedAchievementImage(art, checkpoints, signal)) verifiedArtwork.add(art.path);
  }
  const mappedRecords = [];
  for (const [key, record] of Object.entries(legacyAtlasRecordSources)) {
    const { game, pageId, recordId, detail: [detailPath, detailSha256, bytes], artwork } = record;
    const expected = inventory.pages.get(`${game}/${pageId}`)?.get(recordId);
    const detailUrl = `${atlasSourceOrigin}${detailPath}`;
    if (expected?.detailUrl !== detailUrl) throw new Error($t("legacy-coverage.text_880f10b843", { "key": key }));
    const original = new Set(expected.artwork.map(({ path }) => path));
    const capture = await acquireLegacyAtlasRecord(cache, key, { maxRequests: 0, signal });
    const cached = new Set(capture.files.filter(({ state }) => state === "cached").map(({ sourcePath }) => sourcePath));
    pinnedDetails.add(key);
    if (cached.has(detailPath)) verifiedDetails.add(key);
    const mappedArtwork = artwork.map(([path, galleryPath, sha256, bytes]) => {
      const image = { path: galleryPath, url: `${atlasSourceOrigin}${path}`, sha256, bytes };
      const originalImage = inventory.expectedFiles.get(galleryPath);
      if (!original.has(galleryPath) || !originalImage || !matchLegacyArtwork(image, originalImage)) {
        throw new Error($t("legacy-coverage.text_e190c71e7f", { "key": key, "galleryPath": galleryPath }));
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
    console.error($t("legacy-coverage.text_3d110cd8ca"));
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(await reportLegacyAtlasCoverage(source, cache), null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : $t("legacy-coverage.text_e1dc5ba60d"));
      process.exitCode = 1;
    }
  }
}
