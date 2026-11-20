import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Game } from "./catalog.ts";
import { object } from "./source-values.ts";

export async function candidateFile(root: string, path: string): Promise<string> {
  const source = join(root, path);
  const local = relative(root, source);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local) ||
      await realpath(source) !== source || !(await lstat(source)).isFile()) {
    throw new Error("快照引用的文件必须位于源目录内且为实体文件。");
  }
  return source;
}

export async function copyCandidateFile(source: string, destination: string) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
}

export async function hashCandidateFile(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

export function candidateImageReference(image: Record<string, unknown>, game: Game) {
  if (image.status !== "downloaded" && image.placeholder !== true) return;
  const { localPath: path, sha256 } = image;
  const placeholder = image.placeholder === true;
  if (typeof path !== "string" || /[\\\u0000-\u001f\u007f-\u009f]/u.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      (placeholder ? path !== "gallery/_placeholder/unknown.svg" : !path.startsWith(`gallery/${game}/`))) {
    throw new Error("源图片路径或哈希无效。");
  }
  if (placeholder) return { path, sha256: undefined };
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256)) throw new Error("源图片路径或哈希无效。");
  return { path, sha256 };
}

/** Check referenced images once per source. When assembling, also copy each verified image once. */
export function candidateGallery(destination?: string) {
  const images = new Map<string, { sha256: string; sources: Set<string> }>();
  return {
    get count() { return images.size; },
    async include(item: unknown, game: Game, source: string, signal?: AbortSignal) {
      const { images: list } = object(object(item).meta);
      for (const row of Array.isArray(list) ? list : []) {
        signal?.throwIfAborted();
        const asset = candidateImageReference(object(row), game);
        if (!asset) continue;
        const earlier = images.get(asset.path);
        if (earlier && asset.sha256 && earlier.sha256 !== asset.sha256) throw new Error(`图库路径冲突：${asset.path}`);
        if (earlier?.sources.has(source)) continue;
        const imageFile = await candidateFile(source, asset.path);
        const checksum = await hashCandidateFile(imageFile, signal);
        if ((asset.sha256 && checksum !== asset.sha256) || (earlier && earlier.sha256 !== checksum)) {
          throw new Error(`图库文件内容与记录不符：${asset.path}`);
        }
        if (earlier) earlier.sources.add(source);
        else {
          if (destination) {
            const output = join(destination, asset.path);
            await copyCandidateFile(imageFile, output);
            if (await hashCandidateFile(output, signal) !== checksum) throw new Error(`复制时图库文件发生变化：${asset.path}`);
          }
          images.set(asset.path, { sha256: checksum, sources: new Set([source]) });
        }
      }
    },
  };
}
