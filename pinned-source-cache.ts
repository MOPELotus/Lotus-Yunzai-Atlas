import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const checkpointName = /^[0-9a-f]{64}\.blob$/u;
const partialName = /^\.partial-[0-9a-f-]{36}$/u;

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function openAtlasCheckpointDirectory(path: string, acceptedName: RegExp) {
  if (!path.trim() || /^[a-z][a-z0-9+.-]*:\/\//iu.test(path)) throw new Error($t("pinned-source-cache.text_9a83cbf731"));
  const resolved = resolve(path);
  const directory = join(await realpath(dirname(resolved)), basename(resolved));
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (code(error) !== "EEXIST") throw error;
  });
  if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) {
    throw new Error($t("pinned-source-cache.text_8c333f683d"));
  }
  if ((await readdir(directory)).some((name) => !acceptedName.test(name) && !partialName.test(name))) {
    throw new Error($t("pinned-source-cache.text_32bfdeb0af"));
  }

  function checkpoint(name: string) {
    if (basename(name) !== name || !acceptedName.test(name)) throw new Error($t("pinned-source-cache.text_948d4d0cfb"));
    return join(directory, name);
  }

  return {
    directory,
    async names() { return (await readdir(directory)).filter((name) => acceptedName.test(name)); },
    async read(name: string, limit: number, signal?: AbortSignal): Promise<Buffer | undefined> {
      signal?.throwIfAborted();
      const file = checkpoint(name);
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error) => {
        if (code(error) !== "ENOENT") throw error;
      });
      if (!handle) return;
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) throw new Error($t("pinned-source-cache.text_bd9bfe19d3"));
        if (stats.size < 1 || stats.size > limit) return;
        const bytes = Buffer.alloc(stats.size + 1);
        let size = 0;
        while (size < bytes.length) {
          signal?.throwIfAborted();
          const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size === stats.size) return bytes.subarray(0, size);
      } finally {
        await handle.close();
      }
    },
    async write(name: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      const file = checkpoint(name);
      const temporary = join(directory, `.partial-${randomUUID()}`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        signal?.throwIfAborted();
        await rename(temporary, file);
        const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      } finally {
        await unlink(temporary).catch((error) => {
          if (code(error) !== "ENOENT") throw error;
        });
      }
    },
  };
}

export async function openAtlasPinnedCache(path: string) {
  const cache = await openAtlasCheckpointDirectory(path, checkpointName);
  return {
    directory: cache.directory,
    async read(sha256: string, limit: number, signal?: AbortSignal) {
      const bytes = await cache.read(`${sha256}.blob`, limit, signal);
      return bytes && digest(bytes) === sha256 ? bytes : undefined;
    },
    async write(sha256: string, bytes: Uint8Array, signal?: AbortSignal) {
      if (digest(bytes) !== sha256) throw new Error($t("pinned-source-cache.text_f3f9030b75"));
      await cache.write(`${sha256}.blob`, bytes, signal);
    },
  };
}
