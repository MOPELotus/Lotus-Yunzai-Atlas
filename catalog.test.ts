import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtlasCatalog, findCharacters, findEquipment } from "./catalog.ts";

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
