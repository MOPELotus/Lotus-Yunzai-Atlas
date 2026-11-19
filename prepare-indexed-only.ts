import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { candidateFile } from "./candidate-gallery.ts";
import { readLegacyExportInventory } from "./legacy-coverage.ts";
import { compareLegacyJsonEvidence, evidenceObject, legacyEvidenceType, serializeLegacyJsonEvidence, type EvidenceJson } from "./legacy-json-evidence.ts";
import { legacyAtlasRecordSources } from "./legacy-record-source-profile.ts";
import { legacyAtlasSourcePages, legacyIndexedOnlyPages } from "./legacy-source-profile.ts";
import { openAtlasPinnedCache } from "./pinned-source-cache.ts";
import { readFixedIndexEvidence, readOldItemEvidence } from "./review-legacy-details.ts";
import { atlasSourceOrigin, isAtlasSourceWebp } from "./source-transport.ts";
import { object } from "./source-values.ts";
import { validateAtlasCandidate } from "./validate-candidate.ts";

const pinnedArtwork = new Map(Object.values(legacyAtlasRecordSources).flatMap(({ artwork }) =>
  artwork.map((asset) => [asset[1] as string, asset] as const)));

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return !isAbsolute(path) && path.split(sep)[0] !== "..";
}

async function prepare(source: string, cache: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!(await lstat(cache)).isDirectory()) throw new Error("请指定已有的图鉴索引检查点目录。");
  const checkpoints = await openAtlasPinnedCache(cache);
  const inventory = await readLegacyExportInventory(source, signal);
  const oldData = await realpath(join(source, "data"));
  const legacyMap = object(JSON.parse(await readFile(await candidateFile(oldData, "map.json"), "utf8")));
  const mapGames: Record<string, { game: unknown; locales: { zh: { locale: unknown; pages: Record<string, unknown> } } }> = {};
  const wrappers: { path: string; body: EvidenceJson }[] = [];
  const gallery = new Map<string, Buffer>();
  const requirements = [];
  const pages = [];
  for (const page of legacyAtlasSourcePages) {
    signal?.throwIfAborted();
    const { game, pageId, version, indexSha256, recordCount } = page;
    const key = `${game}/${pageId}`;
    if (!legacyIndexedOnlyPages.has(key)) continue;
    const records = inventory.pages.get(key)!;
    if ([...records.values()].some(({ detailUrl }) => detailUrl !== undefined)) throw new Error(`旧索引类含独立详情（${key}）。`);
    const indexed = await readFixedIndexEvidence(page, checkpoints, signal);
    if (!indexed) throw new Error(`图鉴索引未验证（${game}/${pageId}）。`);
    const fields = new Map<string, Set<string>>();
    const imagePaths = new Map<string, { path: string; url: string; sha256: string; bytes: number; available: boolean }>();
    let placeholderReferences = 0;
    const mapped: { id: string; path: string }[] = [];
    const gameBlock = object(object(legacyMap.games)[game]);
    const oldLocale = object(object(gameBlock.locales).zh);
    const oldPage = object(object(oldLocale.pages)[pageId]);
    const oldMapRecords = object(oldPage.records);
    const mapRecords: Record<string, unknown> = Object.create(null);
    for (const [id, { itemPath, artwork, placeholderReferences: holes }] of records) {
      signal?.throwIfAborted();
      const old = await readOldItemEvidence(oldData, itemPath);
      const oldList = evidenceObject(old.content ?? null).list;
      const list = Object.hasOwn(indexed, id) ? indexed[id] : undefined;
      if (oldList === undefined || list === undefined || legacyEvidenceType(list) !== "object" ||
          compareLegacyJsonEvidence(oldList, list).status !== "exact") throw new Error(`旧条目与固定索引不符（${game}/${pageId}/${id}）。`);
      for (const [key, value] of Object.entries(evidenceObject(list))) {
        const field = /^\d+$/u.test(key) ? "<ID>" : key;
        const types = fields.get(field) ?? new Set<string>();
        types.add(legacyEvidenceType(value));
        fields.set(field, types);
      }
      for (const art of artwork) {
        if (imagePaths.has(art.path)) continue;
        const pin = pinnedArtwork.get(art.path);
        if (pin && art.url === `${atlasSourceOrigin}${pin[0]}` && art.sha256 === pin[2] && art.bytes === pin[3] && !gallery.has(art.path)) {
          const bytes = await checkpoints.read(art.sha256, art.bytes, signal);
          if (bytes?.length === art.bytes && isAtlasSourceWebp(bytes)) gallery.set(art.path, bytes);
        }
        imagePaths.set(art.path, { path: art.path, url: art.url, sha256: art.sha256, bytes: art.bytes, available: gallery.has(art.path) });
      }
      placeholderReferences += holes;
      const meta = evidenceObject(old.meta ?? null);
      const images = Array.isArray(meta.images) ? meta.images.filter((image: EvidenceJson) => {
        const { localPath } = evidenceObject(image);
        return typeof localPath === "string" && gallery.has(localPath);
      }) : [];
      wrappers.push({ path: itemPath, body: { meta: { ...meta, images }, content: { list, detail: null } } });
      mapRecords[id] = { ...object(oldMapRecords[id]), imageCount: images.length };
      mapped.push({ id, path: itemPath });
    }
    (mapGames[game] ??= { game: gameBlock.game, locales: { zh: { locale: oldLocale.locale, pages: {} } } })
      .locales.zh.pages[pageId] = { ...oldPage, records: mapRecords };
    requirements.push({ game, pageId, version, recordCount });
    pages.push({ game, pageId, version, indexSha256, records: mapped, fieldTypes: Object.fromEntries([...fields].map(([field, types]) => [field, [...types].sort()])),
      gallery: [...imagePaths.values()], placeholderReferences });
  }
  const assets = new Map(pages.flatMap(({ gallery }) => gallery.map((asset) => [asset.path, asset] as const)));
  const report = {
    status: "isolated-indexed-only", publishable: false, previewData: "preview/data", pages,
    records: wrappers.length, requiredGalleryFiles: assets.size, missingGalleryFiles: [...assets.values()].filter((asset) => !asset.available),
    placeholderReferences: pages.reduce((sum, page) => sum + page.placeholderReferences, 0),
  } as const;
  return { report, wrappers, gallery, requirements, mapGames };
}

export async function planLegacyIndexedOnlyStage(source: string, cache: string, signal?: AbortSignal) {
  return (await prepare(source, cache, signal)).report;
}

export async function stageLegacyIndexedOnly(source: string, cache: string, destination: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!destination.trim() || /^[a-z][a-z0-9+.-]*:\/\//iu.test(destination)) throw new Error("请指定新的本地图鉴暂存目录。");
  const resolved = resolve(destination);
  const [reference, checkpoints, parent] = await Promise.all([realpath(source), realpath(cache), realpath(dirname(resolved))]);
  const target = join(parent, basename(resolved));
  if ([reference, checkpoints].some((path) => contains(path, target) || contains(target, path))) {
    throw new Error("图鉴暂存目录须与原导出及索引检查点独立。");
  }
  const { report, wrappers, gallery, requirements, mapGames } = await prepare(reference, checkpoints, signal);
  const preview = join(target, "preview");
  await mkdir(target, { mode: 0o700 });
  try {
    for (const { path, body } of wrappers) {
      signal?.throwIfAborted();
      const file = join(preview, path);
      if (!contains(join(preview, "data", "items"), file)) throw new Error("图鉴暂存条目路径越界。");
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${serializeLegacyJsonEvidence(body)}\n`, { flag: "wx" });
    }
    for (const [path, bytes] of gallery) {
      signal?.throwIfAborted();
      const file = join(preview, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes, { flag: "wx" });
    }
    const data = join(preview, "data");
    await writeFile(join(data, "map.json"), `${JSON.stringify({ meta: { mode: report.status }, games: mapGames })}\n`, { flag: "wx" });
    const validation = await validateAtlasCandidate(data, requirements, signal);
    if (!validation.ok) throw new Error(`图鉴暂存未通过运行时结构验证。${validation.issues[0] ?? ""}`);
    await writeFile(join(target, "status.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    return report;
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const [source, cache, destination, ...extra] = Bun.argv.slice(2);
  if (!source || !cache || extra.length) {
    console.error("用法：bun prepare-indexed-only.ts <原导出根> <原索引检查点目录> [新暂存目录]");
    process.exitCode = 2;
  } else {
    try {
      const report = await (destination ? stageLegacyIndexedOnly(source, cache, destination) : planLegacyIndexedOnlyStage(source, cache));
      console.log(JSON.stringify(report, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "无法准备图鉴索引条目。");
      process.exitCode = 1;
    }
  }
}
