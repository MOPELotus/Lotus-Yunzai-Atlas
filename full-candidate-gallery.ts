import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { dirname, join } from "node:path";
import { realpath } from "node:fs/promises";
import { candidateFile, candidateImageReference, hashCandidateFile } from "./candidate-gallery.ts";
import type { Game } from "./catalog.ts";
import { challengeArtworkDigests } from "./challenge-artwork.ts";
import { isAtlasGalleryPath, label, object } from "./source-values.ts";
import { atlasThemeDirectories } from "./theme-directories.ts";

function artworkIn(data: string, signal?: AbortSignal) {
  const observed = new Map<string, Promise<string | undefined>>();
  return async (path: string, expected: string, roots = [data, dirname(data)]): Promise<boolean> => {
    for (const root of roots) {
      signal?.throwIfAborted();
      const key = join(root, path);
      let available = observed.get(key);
      if (!available) {
        available = (async () => hashCandidateFile(await candidateFile(root, path), signal))().catch(() => undefined);
        observed.set(key, available);
      }
      const digest = await available;
      signal?.throwIfAborted();
      if (digest === expected) return true;
    }
    return false;
  };
}

export function inspectFullAtlasImages(data: string, signal?: AbortSignal, issues?: string[]) {
  const hasArtwork = artworkIn(data, signal);
  return {
    async read(game: Game, pageId: string, id: string, images: unknown) {
      const fields = new Map<string, string>();
      for (const element of Array.isArray(images) ? images : Object.values(object(images))) {
        const image = object(element);
        const field = label(image.fieldPath);
        if (image.status !== "downloaded" || image.placeholder === true || !field) continue;
        let digest: string | undefined;
        try {
          const reference = candidateImageReference(image, game);
          if (reference?.sha256 && isAtlasGalleryPath(reference.path, game) &&
              await hasArtwork(reference.path, reference.sha256)) digest = reference.sha256;
        } catch {
          signal?.throwIfAborted();
        }
        if (digest) {
          if (!fields.has(field)) fields.set(field, digest);
        } else if (issues) {
          issues.push($t("full-candidate-gallery.text_bfd63a47cb", { "game": game, "pageId": pageId, "id": id, "field": field }));
        }
      }
      return fields;
    },
  };
}

/** Fixed, hand-audited illustrations can be resolved outside a snapshot. */
export async function inspectFullAtlasArtwork(before: string, after: string, issues: string[], signal?: AbortSignal) {
  const hasBefore = artworkIn(before, signal);
  const hasAfter = artworkIn(after, signal);
  const fallbacks = (await Promise.all(atlasThemeDirectories(import.meta.url, Bun.env.LOTUS_ATLAS_THEME_DIR)
    .map(directory => realpath(directory).catch(() => undefined)))).filter(root => root !== undefined);
  let changed = false;
  for (const [path, expected] of challengeArtworkDigests) {
    if (await hasBefore(path, expected, fallbacks)) continue;
    const [previous, next] = await Promise.all([hasBefore(path, expected), hasAfter(path, expected)]);
    if (previous && !next) issues.push($t("full-candidate-gallery.text_06f63e4b7d", { "path": path }));
    changed ||= previous !== next;
  }
  return changed;
}
