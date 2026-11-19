import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLegacyAtlasRecord } from "./acquire-legacy-record.ts";
import { legacyAtlasRecordSources } from "./legacy-record-source-profile.ts";
import { legacyAtlasSourcePages } from "./legacy-source-profile.ts";

test("固定详情目录和图库路径对应所核原记录，末日详情保留原站目录名", () => {
  expect(Object.values(legacyAtlasRecordSources).map(({ artwork }) => artwork.length)).toEqual([1, 2, 0, 28]);
  expect(legacyAtlasRecordSources["hsr/maze_boss/3022"].detail[0]).toBe("/hsr/4.7.52/zh/boss/3022.json");
  for (const [key, { game, pageId, recordId, detail: [path, sha, size], artwork }] of Object.entries(legacyAtlasRecordSources)) {
    const index = legacyAtlasSourcePages.find((page) => page.game === game && page.pageId === pageId);
    expect(index).toBeDefined();
    expect(key).toBe(`${game}/${pageId}/${recordId}`);
    expect(path.startsWith(`/${game}/${index!.version}/zh/`)).toBe(true);
    expect(path.endsWith(`/${recordId}.json`)).toBe(true);
    expect(sha).toMatch(/^[a-f0-9]{64}$/u);
    expect(size).toBeGreaterThan(0);
    expect(new Set(artwork.map(([path]) => path)).size).toBe(artwork.length);
    for (const [path, gallery, sha, size] of artwork) {
      expect(gallery.startsWith(`gallery/${game}/`)).toBe(true);
      expect(path.startsWith(`/assets/${game}/`)).toBe(true);
      expect(sha).toMatch(/^[a-f0-9]{64}$/u);
      expect(size).toBeGreaterThanOrEqual(20);
    }
  }
});

test("详情准备不接受未知条目、越界限额或未复核的索引检查点", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-record-fixture-"));
  try {
    const directory = join(root, "cache");
    const request = async () => { throw new Error("unexpected HTTP request"); };
    await expect(acquireLegacyAtlasRecord(directory, "gi/weapon/11402", { request })).rejects.toThrow("尚无核实");
    await expect(acquireLegacyAtlasRecord(directory, "gi/weapon/11401", { request, maxRequests: 3 })).rejects.toThrow("0 到 2");
    expect(await readdir(root)).toEqual([]);
    await mkdir(directory);
    const page = legacyAtlasSourcePages.find(({ game, pageId }) => game === "gi" && pageId === "weapon")!;
    const checkpoint = `${page.indexSha256}.blob`;
    await writeFile(join(directory, checkpoint), '{"11401":{}}');
    expect(await acquireLegacyAtlasRecord(directory, "gi/weapon/11401", { request })).toMatchObject({
      status: "index-required", requests: 0, files: [], version: "7.2.52",
    });
    expect(await readdir(directory)).toEqual([checkpoint]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
