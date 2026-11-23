import { atlasLocaleBlock, atlasPageKey, defaultAtlasLocale, parseAtlasLocale } from "./locale.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { candidateFile, candidateGallery, copyCandidateFile } from "./candidate-gallery.ts";
import { legacyAtlasSourcePages } from "./legacy-source-profile.ts";
import { object } from "./source-values.ts";
import { validateAtlasCandidate } from "./validate-candidate.ts";

const exporterPages = new Set(legacyAtlasSourcePages.map(({ game, pageId }) => `${game}/${pageId}`));

/** Prepare the already-private exporter tree from the portions of a published snapshot owned by this exporter. */
export async function seedExporterFromPublished(data: string, backend: string, signal?: AbortSignal) {
  const validation = await validateAtlasCandidate(data, [], signal);
  if (!validation.ok) throw new Error(`现用图鉴无法用作下载种子。${validation.issues[0] ?? ""}`);
  const target = join(backend, "data");
  const snapshotRoot = dirname(data);
  const map = await candidateFile(data, "map.json");
  const listing = object(JSON.parse(await readFile(map, "utf8")));
  const games = object(listing.games);
  const pages = validation.pages.filter(({ game, pageId }) => exporterPages.has(`${game}/${pageId}`));
  if (!pages.length) throw new Error("现用图鉴没有旧导出器支持的分类。");
  const selectedPages: Record<string, string[]> = {};
  for (const { game, pageId } of pages) {
    const selected = selectedPages[game] ??= [];
    if (!selected.includes(pageId)) selected.push(pageId);
  }
  const selectedKeys = new Set(pages.map(atlasPageKey));
  for (const [game, value] of Object.entries(games)) {
    if (!selectedPages[game]) {
      delete games[game];
      continue;
    }
    const gameData = object(value);
    for (const [language, block] of Object.entries(object(gameData.locales))) {
      const locale = parseAtlasLocale(language) ?? parseAtlasLocale(object(object(block).locale).folder);
      const catalog = object(object(block).pages);
      for (const pageId of Object.keys(catalog)) {
        if (!locale || !selectedKeys.has(atlasPageKey({ game, pageId, locale }))) delete catalog[pageId];
      }
    }
  }
  listing.meta = { ...object(listing.meta), selectedPages };
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "map.json"), JSON.stringify(listing) + "\n", { flag: "wx", signal });
  const gallery = candidateGallery(backend);
  const images = [];
  for (const { game, pageId, locale = defaultAtlasLocale } of pages) {
    const gameData = object(object(listing.games)[game]);
    const localized = atlasLocaleBlock(gameData, locale);
    const page = object(object(localized.pages)[pageId]);
    for (const [recordId, value] of Object.entries(object(page.records))) {
      signal?.throwIfAborted();
      const { path } = object(value);
      if (typeof path !== "string" || !path.startsWith("items/")) throw new Error("种子条目路径无效。");
      const source = await candidateFile(data, path);
      const entry = join(target, path);
      await copyCandidateFile(source, entry);
      const item: unknown = JSON.parse(await readFile(entry, "utf8"));
      await gallery.include(item, game, snapshotRoot, signal);
      const rows = object(object(item).meta).images;
      for (const row of Array.isArray(rows) ? rows : []) {
        const image = object(row);
        const retryable = image.placeholder === true && image.status === "placeholder" ? image.retryable ?? false : image.retryable;
        images.push({ ...image, gameId: game, pageId, recordId, retryable, ...(locale !== defaultAtlasLocale && { locale }) });
      }
    }
  }
  const verified = await validateAtlasCandidate(target, pages, signal);
  if (!verified.ok || verified.pages.length !== pages.length) throw new Error("种子图鉴在准备时发生变化。");
  await writeFile(join(target, "gallery-index.json"), JSON.stringify({ images }) + "\n", { flag: "wx", signal });
}
