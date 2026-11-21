import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Game } from "./catalog.ts";
import { isAtlasGalleryPath } from "./source-values.ts";

export function zzzCharacterGalleryRoot() {
  return Bun.env.LOTUS_CHARACTER_GALLERY_DIR?.trim() || fileURLToPath(new URL("../../data/character-gallery/", import.meta.url));
}

export async function readAtlasGalleryImage(root: string, game: Game, path: string | undefined,
  maxBytes = 1024 * 1024): Promise<Uint8Array | undefined> {
  if (!isAtlasGalleryPath(path, game)) return;
  const directory = await realpath(root).catch(() => undefined);
  if (!directory) return;
  const roots = basename(directory) === "data" ? [directory, dirname(directory)] : [directory];
  for (const base of roots) {
    const file = await realpath(join(base, path)).catch(() => undefined);
    if (!file?.startsWith(join(base, "gallery", game) + sep)) continue;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
    if (!handle) continue;
    try {
      const info = await handle.stat();
      if (!info.isFile() || !info.size || info.size > maxBytes) continue;
      const bytes = Buffer.alloc(info.size);
      for (let offset = 0; offset < bytes.length;) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) return;
        offset += bytesRead;
      }
      return bytes;
    } catch {
      continue;
    } finally {
      await handle.close();
    }
  }
}
