import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Game } from "./catalog.ts";
import { object } from "./source-values.ts";

export async function candidateFile(root: string, path: string): Promise<string> {
  const source = join(root, path);
  const local = relative(root, source);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local) ||
      await realpath(source) !== source || !(await lstat(source)).isFile()) {
    throw new Error($t("candidate-gallery.text_c5b8f2ebf0"));
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
    throw new Error($t("candidate-gallery.text_8e2bb9f484"));
  }
  if (placeholder) return { path, sha256: undefined };
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256)) throw new Error($t("candidate-gallery.text_8e2bb9f484"));
  return { path, sha256 };
}

export interface CandidateImageRecovery {
  readonly placeholderSha256: string;
  read(source: string, game: Game, reference: Readonly<Record<string, unknown>>, path: string,
    sha256: string, signal?: AbortSignal): Promise<Buffer | undefined>;
}

/** Check referenced images once per source. When assembling, also copy each verified image once. */
export function candidateGallery(destination?: string, recovery?: CandidateImageRecovery) {
  const images = new Map<string, { sha256: string; sources: Set<string> }>();
  return {
    get count() { return images.size; },
    async include(item: unknown, game: Game, source: string, signal?: AbortSignal) {
      const { images: list } = object(object(item).meta);
      for (const row of Array.isArray(list) ? list : []) {
        signal?.throwIfAborted();
        const reference = object(row);
        const asset = candidateImageReference(reference, game);
        if (!asset) continue;
        const expected = asset.sha256 ?? recovery?.placeholderSha256;
        const earlier = images.get(asset.path);
        if (earlier && expected && earlier.sha256 !== expected) throw new Error($t("candidate-gallery.text_e5b44f21d9", { "path": asset.path }));
        if (earlier?.sources.has(source)) continue;
        let imageFile: string | undefined;
        let checksum: string;
        let bytes: Buffer | undefined;
        try {
          imageFile = await candidateFile(source, asset.path);
          checksum = await hashCandidateFile(imageFile, signal);
          if ((expected && checksum !== expected) || (earlier && earlier.sha256 !== checksum)) {
            throw new Error($t("candidate-gallery.text_1ca4fa7583", { "path": asset.path }));
          }
        } catch (error) {
          signal?.throwIfAborted();
          if (!recovery || !expected) throw error;
          if (earlier?.sha256 === expected) {
            earlier.sources.add(source);
            continue;
          }
          bytes = await recovery.read(source, game, reference, asset.path, expected, signal);
          if (!bytes) throw error;
          checksum = createHash("sha256").update(bytes).digest("hex");
          if (checksum !== expected) throw new Error($t("candidate-gallery.text_e864732606", { "path": asset.path }));
        }
        if (earlier) earlier.sources.add(source);
        else {
          if (destination) {
            const output = join(destination, asset.path);
            if (bytes) {
              await mkdir(dirname(output), { recursive: true });
              await writeFile(output, bytes, { flag: "wx", signal });
            } else {
              await copyCandidateFile(imageFile!, output);
            }
            if (await hashCandidateFile(output, signal) !== checksum) throw new Error($t("candidate-gallery.text_2cf763d5ee", { "path": asset.path }));
          }
          images.set(asset.path, { sha256: checksum, sources: new Set([source]) });
        }
      }
    },
  };
}
