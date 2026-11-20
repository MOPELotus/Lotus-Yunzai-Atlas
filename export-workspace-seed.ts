import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { candidateFile, candidateGallery, copyCandidateFile } from "./candidate-gallery.ts";
import { object } from "./source-values.ts";
import { validateAtlasCandidate } from "./validate-candidate.ts";

/** Prepare the already-private exporter tree from one fixed published snapshot. */
export async function seedExporterFromPublished(data: string, backend: string, signal?: AbortSignal) {
  const validation = await validateAtlasCandidate(data, [], signal);
  if (!validation.ok) throw new Error(`现用图鉴无法用作下载种子。${validation.issues[0] ?? ""}`);
  const target = join(backend, "data");
  const snapshotRoot = dirname(data);
  const map = await candidateFile(data, "map.json");
  await copyCandidateFile(map, join(target, "map.json"));
  const listing = object(JSON.parse(await readFile(join(target, "map.json"), "utf8")));
  const gallery = candidateGallery(backend);
  const images = [];
  for (const { game, pageId } of validation.pages) {
    const gameData = object(object(listing.games)[game]);
    const localized = object(object(gameData.locales).zh);
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
        images.push({ ...image, gameId: game, pageId, recordId, retryable });
      }
    }
  }
  const verified = await validateAtlasCandidate(target, validation.pages, signal);
  if (!verified.ok || verified.pages.length !== validation.pages.length) throw new Error("种子图鉴在准备时发生变化。");
  await writeFile(join(target, "gallery-index.json"), JSON.stringify({ images }) + "\n", { flag: "wx", signal });
}
