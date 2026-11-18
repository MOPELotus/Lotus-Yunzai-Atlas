import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtlasCatalog, findBangboos, findCharacters, findEquipment, findSets } from "./catalog.ts";

test("角色索引保留同名条目，坏快照不替换已验证的索引", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-atlas-"));
  try {
    const mapPath = join(directory, "map.json");
    const fixture = {
      games: {
        gi: {
          locales: { zh: { pages: { character: {
            version: "1", recordCount: 2,
            records: {
              a: { id: "1", name: "角色甲", rarity: "五星", path: "items/one.json" },
              b: { id: "2", name: "角色甲", rarity: "四星", path: "items/two.json" },
            },
          } } } },
        },
      },
    };
    await writeFile(mapPath, JSON.stringify(fixture));
    const catalog = createAtlasCatalog(directory);
    const first = await catalog.read();
    expect(findCharacters(first, "角色 甲").map(({ id }) => id)).toEqual(["1", "2"]);
    expect(findCharacters(first, "１").map(({ id }) => id)).toEqual(["1"]);
    expect(findCharacters(first, "角色甲", "zzz")).toEqual([]);
    await writeFile(mapPath, JSON.stringify({ games: {} }));
    const failed = await catalog.read();
    expect(failed.stale).toBe(true);
    expect(failed.pages[0]).toBe(first.pages[0]);
    fixture.games.gi.locales.zh.pages.character.version = "2";
    await writeFile(mapPath, JSON.stringify(fixture));
    const updated = await catalog.read();
    expect(updated.stale).toBe(false);
    expect(updated.pages[0]?.version).toBe("2");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("绝区零使用详情的等级字段，拒绝旧版本或目录外的条目", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-atlas-"));
  try {
    const catalog = createAtlasCatalog(directory);
    await mkdir(join(directory, "items"));
    const character = { id: "1", name: "角色甲", game: "zzz", version: "2", rarity: "三星",
      path: "items/one.json" } as const;
    const item = { meta: { gameId: "zzz", pageId: "character", recordId: "1", version: "2" },
      content: { list: { rank: 3 } } };
    const file = join(directory, character.path);
    await writeFile(file, JSON.stringify(item));
    expect(await catalog.characterRarity(character)).toBe("A级");
    item.content.list.rank = 4;
    await writeFile(file, JSON.stringify(item));
    expect(await catalog.characterRarity(character)).toBe("S级");
    expect(await catalog.characterRarity({ ...character, version: "1" })).toBe("");

    const items = join(directory, "items");
    const elsewhere = await mkdtemp(join(tmpdir(), "lotus-atlas-outside-"));
    try {
      await writeFile(join(elsewhere, "other.json"), JSON.stringify(item));
      await symlink(join(elsewhere, "other.json"), join(items, "outside.json"));
      expect(await catalog.characterRarity({ ...character, path: "items/outside.json" })).toBe("");
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("装备保留武器、光锥、音擎分类并独立更新各游戏的索引", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-atlas-equipment-"));
  try {
    await mkdir(join(directory, "items"));
    const fixtures = [
      { game: "gi", pageId: "weapon", detail: { type: "WEAPON_SWORD_ONE_HAND" },
        category: "武器", rarity: "五星", scope: "单手剑" },
      { game: "hsr", pageId: "lightcone", detail: { baseType: "Rogue" },
        category: "光锥", rarity: "五星", scope: "巡猎" },
      { game: "zzz", pageId: "weapon", detail: { type: 7, rank: 2 },
        category: "音擎", rarity: "B级", scope: "锋御" },
    ] as const;
    const mapPath = join(directory, "map.json");
    const pages = fixtures.map(({ game, pageId }) => ({
      game, pageId, page: { version: "1", recordCount: 1, records: {
        one: { id: "1", name: "同名装备", rarity: "五星", path: `items/${game}.json` },
      } },
    }));
    const writeMap = () => writeFile(mapPath, JSON.stringify({ games: Object.fromEntries(
      pages.map(({ game, pageId, page }) => [game, { locales: { zh: { pages: { [pageId]: page } } } }]),
    ) }));
    for (const { game, pageId, detail } of fixtures) {
      await writeFile(join(directory, "items", `${game}.json`), JSON.stringify({
        meta: { gameId: game, pageId, recordId: "1", version: "1" },
        content: { list: detail },
      }));
    }
    await writeMap();

    const catalog = createAtlasCatalog(directory);
    const first = await catalog.read();
    expect(findCharacters(first, "同名装备")).toEqual([]);
    expect(findEquipment(first, "同名装备")).toHaveLength(3);
    for (const { game, category, rarity, scope } of fixtures) {
      const [entry] = findEquipment(first, "同名装备", game);
      expect(entry).toBeDefined();
      expect(await catalog.equipmentFacts(entry!)).toEqual({ category, rarity, scope });
    }
    pages[0]!.page.version = "2";
    pages[2]!.page.recordCount = 0;
    await writeMap();
    const second = await catalog.read();
    expect(second.stale).toBe(true);
    expect(findEquipment(second, "1", "gi")[0]?.version).toBe("2");
    expect(findEquipment(second, "1", "zzz")[0]?.version).toBe("1");
    const [updated] = findEquipment(second, "1", "gi");
    expect(await catalog.equipmentFacts(updated!)).toEqual({ category: "武器", rarity: "五星", scope: "" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("套装按同版本详情恢复名称、组件门槛与参数，邦布等级须一致", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-atlas-sets-"));
  try {
    await mkdir(join(directory, "items"));
    const page = (name: string, path: string) => ({
      version: "1", recordCount: 1, records: { one: { id: "1", name, path: `items/${path}.json` } },
    });
    const game = (pages: object) => ({ locales: { zh: { pages } } });
    await writeFile(join(directory, "map.json"), JSON.stringify({ games: {
      gi: game({ artifact: page("1", "artifact") }),
      hsr: game({ relicset: page("位面样例", "relicset") }),
      zzz: game({ equipment: page("驱动盘样例", "disk"), bangboo: page("邦布样例", "bangboo") }),
    } }));
    const detail = (gameId: string, pageId: string, path: string, content: object) =>
      writeFile(join(directory, "items", `${path}.json`), JSON.stringify({
        meta: { gameId, pageId, recordId: "1", version: "1" }, content,
      }));
    await detail("hsr", "relicset", "relicset", { detail: {
      parts: { a: {}, b: {} }, require_num: {
        "2": { desc: "速度达到<unbreak>#1[i]</unbreak>时，提升<unbreak>#2[f1]%</unbreak>。", param_list: [120, 0.075] },
      },
    } });
    await detail("zzz", "equipment", "disk", { detail: { desc2: "<color=#FFFFFF>增益</color>。" } });
    await detail("zzz", "bangboo", "bangboo", { list: { rank: 3 }, detail: { rarity: 3 } });
    const catalog = createAtlasCatalog(directory);
    const partial = await catalog.read();
    expect(partial.stale).toBe(true);
    expect(findSets(partial, "1", "gi")).toEqual([]);

    await detail("gi", "artifact", "artifact", {
      list: { set: { sample: { name: { zh: "圣遗物样例" } } } },
      detail: { need: [1], affix: [{ desc: "样例抗性。" }] },
    });
    const complete = await catalog.read();
    expect(complete.stale).toBe(false);
    const [artifact] = findSets(complete, "圣遗物样例", "gi");
    const [ornament] = findSets(complete, "1", "hsr");
    const [disk] = findSets(complete, "1", "zzz");
    const [bangboo] = findBangboos(complete, "邦布样例");
    expect(await catalog.setFacts(artifact!)).toEqual({
      category: "圣遗物", effects: [{ pieces: 1, text: "样例抗性。" }],
    });
    expect(await catalog.setFacts(ornament!)).toEqual({
      category: "位面饰品", effects: [{ pieces: 2, text: "速度达到120时，提升7.5%。" }],
    });
    expect(await catalog.setFacts(disk!)).toEqual({
      category: "驱动盘", effects: [{ pieces: 2, text: "增益。" }],
    });
    expect(await catalog.bangbooRarity(bangboo!)).toBe("A级");
    await detail("zzz", "bangboo", "bangboo", { list: { rank: 3 }, detail: { rarity: 4 } });
    expect(await catalog.bangbooRarity(bangboo!)).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("同尺寸同修改时间的覆写会使索引失效", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-atlas-cache-"));
  try {
    const mapPath = join(directory, "map.json");
    const stamp = new Date("2026-01-01T00:00:00.000Z");
    const writeMap = async (version: string) => {
      const page = { version, recordCount: 1,
        records: { one: { id: "1", name: "角色样例", path: "items/one.json" } } };
      await writeFile(mapPath, JSON.stringify({ games: {
        gi: { locales: { zh: { pages: { character: page } } } },
      } }));
      await utimes(mapPath, stamp, stamp);
      const { dev, ino, size, mtimeMs } = await stat(mapPath);
      return { dev, ino, size, mtimeMs };
    };
    const catalog = createAtlasCatalog(directory);
    const firstMeta = await writeMap("1");
    const first = await catalog.read();
    expect((await catalog.read()).pages).toBe(first.pages);

    for (const version of ["2", "3", "4", "5"]) {
      expect(await writeMap(version)).toEqual(firstMeta);
      const current = await catalog.read();
      expect(current.stale).toBe(false);
      expect(current.pages[0]?.version).toBe(version);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
