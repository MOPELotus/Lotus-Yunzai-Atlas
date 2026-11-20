import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtlasRuntimeCatalog, findEquipment } from "./catalog.ts";
import { findLegacyAtlasExport } from "./legacy-atlas-directory.ts";

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
