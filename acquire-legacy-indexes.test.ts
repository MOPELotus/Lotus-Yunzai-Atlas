import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLegacyAtlasIndexes } from "./acquire-legacy-indexes.ts";
import { legacyAtlasSourcePages } from "./legacy-source-profile.ts";
import { openAtlasPinnedCache } from "./pinned-source-cache.ts";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-pinned-cache-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("原始字节检查点保留大整数，并可复核、修复损坏和并行落盘", () => fixture(async (root) => {
  const directory = join(root, "cache");
  const cache = await openAtlasPinnedCache(directory);
  const bytes = Buffer.from('{"stage_name":3513447881416968543}\n');
  const sha = createHash("sha256").update(bytes).digest("hex");
  const path = join(directory, `${sha}.blob`);
  const orphan = ".partial-00000000-0000-0000-0000-000000000000";
  await writeFile(join(directory, orphan), "partial file after exit");
  expect(await cache.read(sha, 1024)).toBeUndefined();
  await Promise.all([cache.write(sha, bytes), cache.write(sha, bytes)]);
  expect(await readdir(directory)).toEqual([orphan, `${sha}.blob`].sort());
  expect(await (await openAtlasPinnedCache(directory)).read(sha, 1024)).toEqual(bytes);
  expect(await cache.read(sha, 1)).toBeUndefined();
  await writeFile(path, "corrupt");
  expect(await cache.read(sha, 1024)).toBeUndefined();
  await expect(cache.write(sha, Buffer.from("wrong"))).rejects.toThrow("SHA-256 不符");
  expect(await readFile(path, "utf8")).toBe("corrupt");
  await cache.write(sha, bytes);
  expect(await readFile(path)).toEqual(bytes);
  await rm(path);
  await symlink(join(directory, orphan), path);
  await expect(cache.read(sha, 1024)).rejects.toThrow();
  expect(await readFile(join(directory, orphan), "utf8")).toBe("partial file after exit");
}));

test("请求限额、错误响应或取消均无完成标记，且下载不写入有效图鉴根", () => fixture(async (root) => {
  const atlas = join(root, "atlas");
  await mkdir(join(atlas, "theme"), { recursive: true });
  await expect(acquireLegacyAtlasIndexes(atlas)).rejects.toThrow("图鉴下载目录须为空");
  expect(await readdir(atlas)).toEqual(["theme"]);

  const workspace = join(root, "cache");
  const controller = new AbortController();
  let manifests = 0;
  const manifest = async () => { manifests++; return { gi: { available: ["7.2.52"] } }; };
  const calls: string[] = [];
  const request = async (url: string) => { calls.push(url); return Response.json({ "1": {} }); };
  const first = await acquireLegacyAtlasIndexes(workspace, { manifest, request, maxRequests: 1 });
  expect(first).toMatchObject({ status: "incomplete", verifiedRecordCount: 0, requests: 1 });
  expect(first.pages[0]?.state).toBe("content-mismatch");
  expect(first.pages.slice(1).every(({ state }) => state === "pending")).toBe(true);
  expect(calls).toEqual([`https://static.nanoka.cc${legacyAtlasSourcePages[0]!.indexPath}`]);
  expect(await readdir(workspace)).toEqual([]);

  expect(await acquireLegacyAtlasIndexes(workspace, { manifest, request, maxRequests: 0 })).toMatchObject({ status: "incomplete", requests: 0 });
  expect(manifests).toBe(1);
  const interrupted = acquireLegacyAtlasIndexes(workspace, { manifest, signal: controller.signal, async request() {
    controller.abort(new Error("fixture cancelled"));
    return new Response("");
  } });
  await expect(interrupted).rejects.toThrow("fixture cancelled");
  expect(await readdir(workspace)).toEqual([]);
}));
