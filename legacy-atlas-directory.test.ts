import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtlasRuntimeCatalog, findEquipment } from "./catalog.ts";
import { atlasRootIsEmpty, findLegacyAtlasExport } from "./legacy-atlas-directory.ts";
import { rebuildLegacyAtlasIndex } from "./rebuild-legacy-index.ts";

async function writeSource(root: string, name: string) {
  const data = join(root, "data");
  await mkdir(data, { recursive: true });
  const page = { version: "1", recordCount: 1, records: { "1": { id: "1", name, path: "items/weapon.json" } } };
  await writeFile(join(data, "map.json"), JSON.stringify({ games: {
    gi: { locales: { zh: { pages: { weapon: page } } } },
  } }));
}

test("主快照或显式目录优先，坏指针不会使用先前读取的旧导出", async () => {
  const host = await mkdtemp(join(tmpdir(), "lotus-runtime-atlas-"));
  const primary = join(host, "data", "atlas");
  const old = join(host, "plugins", "Lotus-Plugin", "data", "atlas");
  const explicit = join(host, "explicit");
  try {
    await writeSource(old, "原装备");
    await writeSource(explicit, "指定装备");
    const catalog = createAtlasRuntimeCatalog(primary);
    const first = findEquipment(await catalog.read(), "原装备")[0]!;
    expect(catalog.assetRoot(first)).toBe(join(old, "data"));
    expect(findEquipment(await createAtlasRuntimeCatalog(primary, join(explicit, "data")).read(), "指定装备")).toHaveLength(1);
    await expect(createAtlasRuntimeCatalog(primary, join(explicit, "absent")).read()).rejects.toThrow();

    await mkdir(primary, { recursive: true });
    await symlink("snapshots/123/data", join(primary, "current"), "dir");
    await expect(catalog.read()).rejects.toThrow();
    await rm(join(primary, "current"));
    await writeSource(primary, "主装备");
    const mainData = await catalog.read();
    expect(mainData.stale).toBe(false);
    expect(findEquipment(mainData, "主装备")).toHaveLength(1);
    expect(findEquipment(mainData, "原装备")).toEqual([]);
  } finally {
    await rm(host, { recursive: true, force: true });
  }
});

test("第二种旧目录独立可用，双来源不同则报错，同实体导出合并", async () => {
  const host = await mkdtemp(join(tmpdir(), "lotus-runtime-atlas-dual-"));
  const primary = join(host, "data", "atlas");
  const original = join(host, "plugins", "Lotus-Plugin", "data", "atlas");
  const renamed = join(host, "plugins", "Lotus-ReFactor", "data", "atlas");
  try {
    await writeSource(renamed, "新版旧装备");
    const catalog = createAtlasRuntimeCatalog(primary);
    expect(findEquipment(await catalog.read(), "新版旧装备")).toHaveLength(1);
    expect(await findLegacyAtlasExport(primary)).toBe(renamed);

    await writeSource(original, "旧版旧装备");
    await expect(catalog.read()).rejects.toThrow("两个不同的旧图鉴导出");
    await expect(findLegacyAtlasExport(primary)).rejects.toThrow("两个不同的旧图鉴导出");

    await rm(original, { recursive: true });
    await symlink(renamed, original, "dir");
    expect(await findLegacyAtlasExport(primary)).toBe(renamed);
    expect(findEquipment(await catalog.read(), "新版旧装备")).toHaveLength(1);
  } finally {
    await rm(host, { recursive: true, force: true });
  }
});

test("旧版缺索引时重建已验证的实体条目，实体快照或坏索引保持原判定", async () => {
  const host = await mkdtemp(join(tmpdir(), "lotus-runtime-atlas-unindexed-"));
  const primary = join(host, "data/atlas");
  const old = join(host, "plugins/Lotus-ReFactor/data/atlas/data");
  const folder = join(old, "items/简体中文/原神/武器/四星");
  const version = "7.2.52";
  const item = (id: string, name: string, selected = version, sourceOrigin = "https://static.nanoka.cc") => JSON.stringify({
    meta: { gameId: "gi", gameFolder: "原神", locale: "zh", localeFolder: "简体中文", pageId: "weapon", pageFolder: "武器",
      recordId: id, name, rarity: "四星", version: selected, sourcePath: `${selected}/weapon.json`,
      sourceUrl: `${sourceOrigin}/gi/${selected}/weapon.json`, hasDetail: false, images: [] },
    content: { list: { id, type: "WEAPON_SWORD_ONE_HAND" }, detail: null },
  });
  try {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "西风剑__11402.json"), item("11402", "西风剑"));
    await writeFile(join(folder, "西风剑.json"), item("11401", "西风剑"));
    expect(await atlasRootIsEmpty(primary)).toBe(false);
    expect(await findLegacyAtlasExport(primary)).toBeUndefined();
    const catalog = createAtlasRuntimeCatalog(primary);
    const checked = await catalog.read();
    expect(checked.rebuilt).toBe(true);
    expect(findEquipment(checked, "西风剑").map(({ id }) => id)).toEqual(["11401", "11402"]);
    expect((await catalog.equipmentFacts(findEquipment(checked, "11401")[0]!)).scope).toBe("单手剑");
    expect((await createAtlasRuntimeCatalog(primary, old).read()).pages).toEqual(checked.pages);
    expect(await Bun.file(join(old, "map.json")).exists()).toBe(false);
    expect(await rebuildLegacyAtlasIndex(old)).toEqual(await rebuildLegacyAtlasIndex(old));

    await writeFile(join(old, "map.json"), "{ broken");
    await expect(catalog.read()).rejects.toThrow();
    await rm(join(old, "map.json"));
    await writeFile(join(folder, "错误.json"), item("9", "错误", "7.1.52"));
    await expect(catalog.read()).rejects.toThrow("无法恢复索引");
    await writeFile(join(folder, "错误.json"), item("9", "错误", version, "https://example.invalid"));
    await expect(catalog.read()).rejects.toThrow("无法恢复索引");
    await rm(join(folder, "错误.json"));
    await symlink(join(folder, "西风剑.json"), join(folder, "外链.json"));
    await expect(catalog.read()).rejects.toThrow("无法恢复索引");
    await rm(join(folder, "外链.json"));
    const published = join(primary, "snapshots/1/data");
    const publishedFolder = join(published, "items/简体中文/原神/武器/四星");
    await mkdir(publishedFolder, { recursive: true });
    await writeFile(join(publishedFolder, "西风剑.json"), item("11401", "西风剑"));
    await symlink("snapshots/1/data", join(primary, "current"), "dir");
    await expect(catalog.read()).rejects.toThrow();
  } finally { await rm(host, { recursive: true, force: true }); }
});
