import { atlasLocaleBlock, defaultAtlasLocale } from "./locale.ts";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { candidateFile, candidateGallery, candidateImageReference, copyCandidateFile, hashCandidateFile } from "./candidate-gallery.ts";
import { challengeArtworkDigests } from "./challenge-artwork.ts";
import { evidenceObject, parseLegacyJsonEvidence, serializeLegacyJsonEvidence } from "./legacy-json-evidence.ts";
import { atlasSourcePlaceholder } from "./source-acquisition.ts";
import { object } from "./source-values.ts";
import { candidateJson, validateAtlasCandidate, type AtlasCandidateValidation } from "./validate-candidate.ts";
import type { Game } from "./catalog.ts";

const placeholder = "gallery/_placeholder/unknown.svg";
const retainedIndex = "retained-gallery.json";

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function galleryGame(path: unknown): Game {
  if (typeof path === "string") {
    const segment = path.split("/")[1];
    if (segment === "gi" || segment === "hsr" || segment === "zzz") return segment;
  }
  throw new Error("保留图库的游戏路径无效。");
}

function retainedReference(path: string, reference: Record<string, unknown>) {
  return { status: "downloaded", placeholder: false, localPath: path, sha256: reference.sha256,
    remoteUrl: reference.remoteUrl ?? reference.url ?? null, bytes: reference.bytes ?? null,
    contentType: reference.contentType ?? null };
}

export async function* atlasCandidateItems(directory: string, pages: AtlasCandidateValidation["pages"], signal?: AbortSignal) {
  const map: unknown = JSON.parse(await readFile(await candidateFile(directory, "map.json"), "utf8"));
  const games = object(object(map).games);
  for (const { game, pageId, locale = defaultAtlasLocale } of pages) {
    const pageMap = object(atlasLocaleBlock(games[game], locale).pages);
    for (const record of Object.values(object(object(pageMap[pageId]).records))) {
      signal?.throwIfAborted();
      const { path } = object(record);
      if (typeof path !== "string" || !path.startsWith("items/")) throw new Error("候选条目路径无效。");
      const file = await candidateFile(directory, path);
      const raw = await readFile(file, "utf8");
      yield { game, file, raw, item: object(JSON.parse(raw)) };
    }
  }
}

/** Keep the active gallery under the new data pointer without marking any newly downloaded bytes as available. */
export async function retainAtlasGallery(candidate: string, pages: AtlasCandidateValidation["pages"], baseline?: string, signal?: AbortSignal) {
  const directory = dirname(candidate);
  const temp = await mkdtemp(join(dirname(directory), ".retain-gallery-"));
  try {
    const previous = new Map<string, ReturnType<typeof retainedReference>>();
    if (baseline) {
      const validated = await validateAtlasCandidate(baseline, [], signal);
      if (!validated.ok) throw new Error("现用图库的索引不可验证。");
      const gallery = candidateGallery(temp);
      const source = dirname(baseline);
      for await (const { game, item } of atlasCandidateItems(baseline, validated.pages, signal)) {
        await gallery.include(item, game, source, signal);
        const images = object(item.meta).images;
        for (const row of Array.isArray(images) ? images : []) {
          const reference = object(row);
          const asset = candidateImageReference(reference, game);
          if (asset?.sha256 && !previous.has(asset.path)) previous.set(asset.path, retainedReference(asset.path, reference));
        }
      }
      const prior: unknown = await candidateJson(baseline, retainedIndex).catch(error => {
        if (!missing(error)) throw error;
        return [];
      });
      if (!Array.isArray(prior)) throw new Error("保留图库索引无效。");
      for (const row of prior) {
        const reference = object(row);
        const game = galleryGame(reference.localPath);
        const asset = candidateImageReference(reference, game);
        if (!asset?.sha256) throw new Error("保留图库的引用无效。");
        await gallery.include({ meta: { images: [reference] } }, game, source, signal);
        if (!previous.has(asset.path)) previous.set(asset.path, retainedReference(asset.path, reference));
      }
      for (const [path, hash] of challengeArtworkDigests) {
        if (previous.has(path)) continue;
        for (const source of [baseline, dirname(baseline)]) {
          const file = await candidateFile(source, path).catch(() => undefined);
          if (!file || await hashCandidateFile(file, signal) !== hash) continue;
          await copyCandidateFile(file, join(temp, path));
          break;
        }
      }
    }

    let needsPlaceholder = false;
    for await (const { game, file, raw, item } of atlasCandidateItems(candidate, pages, signal)) {
      const meta = object(item.meta);
      if (!Array.isArray(meta.images)) continue;
      const changes = new Map<number, ReturnType<typeof evidenceObject>>();
      for (const [index, row] of meta.images.entries()) {
        const reference = object(row);
        const asset = candidateImageReference(reference, game);
        if (!asset) continue;
        if (reference.placeholder === true) {
          needsPlaceholder = true;
          continue;
        }
        const known = previous.get(asset.path);
        if (known && known.sha256 === asset.sha256) continue;
        const url = reference.remoteUrl ?? reference.url;
        const patch = known && typeof url === "string" && url.startsWith("https://static.nanoka.cc/") &&
            known.remoteUrl === url
          ? { sha256: known.sha256, bytes: known.bytes ?? null, contentType: known.contentType ?? null }
          : { status: "not-synced", localPath: null, sha256: null, bytes: null, contentType: null };
        changes.set(index, evidenceObject(parseLegacyJsonEvidence(JSON.stringify(patch))));
      }
      if (changes.size) {
        const record = evidenceObject(parseLegacyJsonEvidence(raw));
        const header = evidenceObject(record.meta!);
        if (!Array.isArray(header.images)) throw new Error("候选图片引用无效。");
        const images = header.images.map((row, index) => changes.has(index) ? { ...evidenceObject(row), ...changes.get(index) } : row);
        await writeFile(file, serializeLegacyJsonEvidence({ ...record, meta: { ...header, images } }) + "\n", { signal });
      }
    }
    if (needsPlaceholder) {
      const path = join(temp, placeholder);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, atlasSourcePlaceholder, { flag: "wx", signal }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
    }
    signal?.throwIfAborted();
    if (previous.size) await writeFile(join(candidate, retainedIndex), JSON.stringify([...previous.values()]) + "\n", { flag: "wx", signal });
    const projected = join(temp, "gallery");
    await rm(join(directory, "gallery"), { recursive: true, force: true });
    await rename(projected, join(directory, "gallery")).catch(error => {
      if (!missing(error)) throw error;
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
