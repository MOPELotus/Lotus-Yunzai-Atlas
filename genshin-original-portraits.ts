import { reportAtlasInitializationProgress as reportProgress, type AtlasInitializationProgressCallback } from "./initialization-progress.ts";
import { atlasLocaleBlock, defaultAtlasLocale } from "./locale.ts";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { candidateFile, hashCandidateFile } from "./candidate-gallery.ts";
import { evidenceObject, parseLegacyJsonEvidence, serializeLegacyJsonEvidence } from "./legacy-json-evidence.ts";
import { genshinRolePortraitFields } from "./role-data.ts";
import { atlasSourceOrigin, isAtlasSourceWebp, readAtlasSourceBytes, type AtlasSourceFetch } from "./source-transport.ts";
import { galleryArtwork, object } from "./source-values.ts";

// These original assets were separately decoded and checked against the 7.2 / 7.2.52 roster.
// The analogous two Mannequin names carry the same two-person composition and are excluded.
const portraits = [
  ["10000136", "米提亚", "Mitya", 374752, "c2d1451ceca5699eb2452814e99ce86d3fdf8667fb9b1b42c0cc5438508d501f"],
  ["10000137", "瓦列里", "Valeriy", 345402, "a90c1f73df1016cd6113b92dc9d099d3ab991c1cde9b3cb25d919db4ac6d7061"],
  ["10000147", "达妮卡", "Danica", 547020, "e9b38a53f79532d39ba466b35afb5f1a16a72b9cbaf07424c7c4598b6c845679"],
  ["10000149", "安娜丝塔夏", "Anastasya", 732032, "bd35ce0f01ef008f843e8e73c7b59d8d03951df9e109e654e8e974cec1c3ec52"],
] as const;
const fieldPath = "derived.avatarGacha";

async function writeAtomic(filepath: string, data: string | Buffer, signal?: AbortSignal) {
  const parent = dirname(filepath);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, ".atlas-portrait-"));
  try {
    const temporary = join(stage, "file");
    await writeFile(temporary, data, { signal });
    signal?.throwIfAborted();
    await rename(temporary, filepath);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function* matchedGenshinPortraits(data: string, version: string, signal?: AbortSignal, locale = defaultAtlasLocale) {
  const map = object(await Bun.file(await candidateFile(data, "map.json")).json());
  const page = object(atlasLocaleBlock(object(map.games).gi, locale).pages).character;
  const roles = object(object(page).records);
  if (object(page).version !== version) return;
  for (const [id, name, codename, size, sha256] of portraits) {
    signal?.throwIfAborted();
    const entry = object(roles[id]);
    const { path } = entry;
    if (entry.id !== id || (locale === defaultAtlasLocale && entry.name !== name) || typeof path !== "string") continue;
    const file = await candidateFile(data, path);
    const raw = await Bun.file(file).text();
    const item = object(JSON.parse(raw));
    const meta = object(item.meta);
    const content = object(item.content);
    const icon = `UI_AvatarIcon_${codename}`;
    if (meta.recordId !== id || meta.name !== entry.name || meta.version !== version || meta.gameId !== "gi" ||
        object(content.list).icon !== icon || object(content.detail).icon !== icon) continue;
    if (!Array.isArray(meta.images)) continue;
    const artwork = galleryArtwork(meta.images, "gi");
    if (!artwork("detail.icon", "icon")) continue;
    const filename = `UI_Gacha_AvatarImg_${codename}.webp`;
    const localPath = `gallery/gi/${filename}`;
    const attached = meta.images.some((image) => {
      const current = object(image);
      return current.fieldPath === fieldPath && current.localPath === localPath && current.sha256 === sha256 &&
        current.status === "downloaded" && current.placeholder === false;
    });
    if (!attached && artwork(...genshinRolePortraitFields)) continue;
    const hasImage = await candidateFile(dirname(data), localPath).then((image) => hashCandidateFile(image, signal))
      .then((digest) => digest === sha256).catch(() => false);
    yield { id, file, raw, filename, localPath, size, sha256, attached, hasImage };
  }
}

export async function genshinOriginalPortraitStatus(data: string, version: string, signal?: AbortSignal, locale = defaultAtlasLocale) {
  const ready: string[] = [];
  const pending: string[] = [];
  for await (const { id, attached, hasImage } of matchedGenshinPortraits(data, version, signal, locale)) {
    (attached && hasImage ? ready : pending).push(id);
  }
  return { ready, pending };
}

/** Supplement a locked public exporter workspace after its original role records have passed validation. */
export async function completeGenshinPortraits(root: string, version: string, signal?: AbortSignal, request: AtlasSourceFetch = fetch, locale = defaultAtlasLocale, onProgress?: AtlasInitializationProgressCallback) {
  const data = join(root, "data");
  await reportProgress(onProgress, { stage: "portraits", message: "核对原神补充立绘" }, signal);
  const matched = [];
  for await (const entry of matchedGenshinPortraits(data, version, signal, locale)) matched.push(entry);
  let completed = 0;
  for (const { file, raw, filename, localPath, size, sha256, attached, hasImage } of matched) {
    try {
      const url = `${atlasSourceOrigin}/assets/gi/${filename}`;
      if (!hasImage) {
        const bytes = await readAtlasSourceBytes(url, "image/webp", size, true, signal, request).catch(() => undefined);
        signal?.throwIfAborted();
        if (!bytes || bytes.length !== size || !isAtlasSourceWebp(bytes) ||
            createHash("sha256").update(bytes).digest("hex") !== sha256) continue;
        await writeAtomic(join(root, localPath), bytes, signal);
      }
      if (attached) continue;
      const record = evidenceObject(parseLegacyJsonEvidence(raw));
      const header = evidenceObject(record.meta!);
      if (!Array.isArray(header.images)) continue;
      const added = parseLegacyJsonEvidence(JSON.stringify({
        fieldPath, status: "downloaded", placeholder: false, localPath, sha256, url, bytes: size,
      }));
      const next = { ...record, meta: { ...header, images: [...header.images, added] } };
      await writeAtomic(file, serializeLegacyJsonEvidence(next) + "\n", signal);
    } finally {
      await reportProgress(onProgress, { stage: "portraits", message: "原神补充立绘已检查", completed: ++completed, total: matched.length, unit: "张" }, signal);
    }
  }
}
