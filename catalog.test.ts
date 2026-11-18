import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtlasCatalog, findCharacters } from "./catalog.ts";

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
    expect(failed.pages).toBe(first.pages);
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
