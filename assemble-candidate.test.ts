import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assembleAtlasCandidate, copyAtlasCandidate } from "./assemble-candidate.ts";
import type { Game } from "./catalog.ts";

interface RecordFixture {
  id: string;
  file: string;
  art?: { path: string; bytes: string };
}

interface PageFixture {
  game: Game;
  pageId: string;
  version: string;
  rows: RecordFixture[];
}

async function write(root: string, path: string, value: string) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, value);
}

async function snapshot(root: string, pages: PageFixture[]) {
  const games: Record<string, { game: { versions: string[]; requestedVersion: string }; locales: { zh: { pages: Record<string, unknown> } } }> = {};
  for (const { game, pageId, version, rows } of pages) {
    const gameMap = games[game] ??= { game: { versions: [version], requestedVersion: version }, locales: { zh: { pages: {} } } };
    const records: Record<string, unknown> = {};
    for (const { id, file, art } of rows) {
      const path = `items/${game}/${file}.json`;
      records[id] = { id, name: file, path, hasDetail: false };
      await write(root, `data/${path}`, JSON.stringify({
        meta: { gameId: game, pageId, locale: "zh", recordId: id, name: file, hasDetail: false, version,
          images: art ? [{ localPath: art.path, status: "downloaded", placeholder: false,
            sha256: createHash("sha256").update(art.bytes).digest("hex") }] : [] },
        content: { list: { label: file }, detail: null },
      }));
      if (art) await write(root, art.path, art.bytes);
    }
    gameMap.locales.zh.pages[pageId] = { id: pageId, version, recordCount: rows.length,
      totalRecordCount: rows.length, sampled: false, records };
  }
  await write(root, "data/map.json", JSON.stringify({ meta: { source: "fixture" }, games }));
}

const art = { path: "gallery/gi/shared.webp", bytes: "old asset" };
const basePages: PageFixture[] = [
  { game: "gi", pageId: "character", version: "1", rows: [{ id: "3", file: "保留", art }] },
  { game: "gi", pageId: "weapon", version: "1", rows: [{ id: "1", file: "旧名" }, { id: "2", file: "删除" }] },
  { game: "hsr", pageId: "relicset", version: "3", rows: [{ id: "4", file: "其他游戏" }] },
];
const scope = [{ game: "gi", pageId: "weapon", version: "2", recordCount: 1 }] as const;

test("合成整体替换选定分类，保留原分类、图片和真实混合版本", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-merge-"));
  try {
    const base = join(root, "base"), donor = join(root, "donor"), target = join(root, "assembled");
    await snapshot(base, basePages);
    await snapshot(donor, [
      { game: "gi", pageId: "character", version: "2", rows: [{ id: "34", file: "更新源未选定分类" }] },
      { game: "gi", pageId: "weapon", version: "2", rows: [{ id: "1", file: "新名", art }] },
    ]);
    const assembled = await assembleAtlasCandidate(base, donor, target, scope);
    expect(assembled.validation.ok).toBe(true);
    expect(assembled.imageCount).toBe(1);
    const original = await Bun.file(join(base, "data/map.json")).json();
    const output = await Bun.file(join(target, "data/map.json")).json();
    expect(output.games.gi.game).toMatchObject({ versions: ["1", "2"], requestedVersion: null });
    expect(output.games.hsr).toEqual(original.games.hsr);
    expect(output.games.gi.locales.zh.pages.character).toEqual(original.games.gi.locales.zh.pages.character);
    expect(output.games.gi.locales.zh.pages.weapon.records["1"].name).toBe("新名");
    expect(output.games.gi.locales.zh.pages.weapon.records["2"]).toBeUndefined();
    expect(await Bun.file(join(target, "data/items/gi/旧名.json")).exists()).toBe(false);
    expect(await Bun.file(join(target, "data/items/gi/删除.json")).exists()).toBe(false);
    expect(await Bun.file(join(target, "data/items/gi/更新源未选定分类.json")).exists()).toBe(false);
    expect(await readFile(join(target, art.path), "utf8")).toBe(art.bytes);
    expect(await readFile(join(target, "data/items/gi/保留.json"), "utf8")).toBe(await readFile(join(base, "data/items/gi/保留.json"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("图库冲突或缺失时清理隔离候选，现有目标和来源保持原状", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-merge-rejected-"));
  try {
    const base = join(root, "base"), donor = join(root, "donor"), target = join(root, "assembled");
    await snapshot(base, basePages);
    await snapshot(donor, [{ game: "gi", pageId: "weapon", version: "2", rows: [
      { id: "1", file: "新名", art: { ...art, bytes: "new asset" } },
    ] }]);
    await expect(assembleAtlasCandidate(base, donor, target, scope)).rejects.toThrow("图库路径冲突");
    expect(await Bun.file(join(target, "data/map.json")).exists()).toBe(false);
    expect(await readFile(join(base, art.path), "utf8")).toBe(art.bytes);
    await snapshot(donor, [{ game: "gi", pageId: "weapon", version: "2", rows: [{ id: "1", file: "新名", art }] }]);
    await rm(join(donor, art.path));
    await expect(assembleAtlasCandidate(base, donor, target, scope)).rejects.toThrow();
    await mkdir(target);
    await write(target, "sentinel", "原目录");
    await expect(assembleAtlasCandidate(base, donor, target, scope)).rejects.toThrow();
    expect(await readFile(join(target, "sentinel"), "utf8")).toBe("原目录");
    await expect(assembleAtlasCandidate(base, donor, join(base, "incoming"), scope)).rejects.toThrow("独立目录");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("首版候选复验完整原索引、详情总数和原图哈希", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-first-copy-"));
  try {
    const source = join(root, "source"), target = join(root, "staged");
    await snapshot(source, [{ game: "gi", pageId: "weapon", version: "2", rows: [{ id: "1", file: "样例", art }] }]);
    await expect(copyAtlasCandidate(source, target, scope, { imageCount: 1, detailCount: 1 })).rejects.toThrow("详情或图库数量");
    await expect(copyAtlasCandidate(source, target, [{ ...scope[0], recordCount: 2 }], { imageCount: 1, detailCount: 0 }))
      .rejects.toThrow("未通过校验");
    await writeFile(join(source, art.path), "wrong bytes");
    await expect(copyAtlasCandidate(source, target, scope, { imageCount: 1, detailCount: 0 })).rejects.toThrow("图库文件内容与记录不符");
    await writeFile(join(source, art.path), art.bytes);
    const result = await copyAtlasCandidate(source, target, scope, { imageCount: 1, detailCount: 0 });
    expect(result.validation.pages).toEqual(scope);
    expect(await Bun.file(join(target, "data/map.json")).json()).toEqual(await Bun.file(join(source, "data/map.json")).json());
    expect(await Bun.file(join(target, art.path)).text()).toBe(art.bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
