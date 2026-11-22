import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtlasCatalog, findBangboos, findCharacters, findEquipment, findMonsters, findSets, findTraditionalEntries } from "./catalog.ts";

test("原神装备旧称只匹配已核对的武器与圣遗物套装，标题保留正式名称", () => {
  const weapon = { game: "gi", id: "11509", name: "雾切之回光", version: "7.2", rarity: "五星", path: "items/11509.json" } as const;
  const set = { ...weapon, id: "14001", name: "冰风迷途的勇士", path: "items/14001.json" };
  const common = { game: "gi", version: "7.2", sampled: false } as const;
  const other = { ...weapon, id: "1", name: "雾切的试作" };
  const catalog = { pages: [
    { ...common, kind: "equipment", name: "武器", entries: [other, weapon] },
    { ...common, kind: "set", name: "圣遗物", entries: [set] },
  ] as const, stale: false };
  for (const [alias, entry, kind] of [["雾切", weapon, "equipment"], ["冰封迷途的勇士", set, "set"]] as const) {
    expect(findTraditionalEntries(catalog, alias, "gi", "name")).toEqual([{ entry, kind, score: 2.5 }]);
    expect(findTraditionalEntries(catalog, alias, "gi", "equipment").map(({ entry }) => entry)).toEqual([entry]);
    expect(findTraditionalEntries(catalog, alias, "hsr", "name")).toEqual([]);
  }
  expect(findEquipment(catalog, "雾切")).toEqual([weapon]);
  expect(findSets(catalog, "冰封迷途的勇士")).toEqual([set]);
  expect(findTraditionalEntries(catalog, "冰封", "gi", "name")).toEqual([]);
});

test("旧版角色昵称与套装简称按游戏、类型查询并保留正式名优先", () => {
  const common = { version: "7.2", rarity: "", path: "items/example.json" };
  const furina = { ...common, game: "gi", id: "10000089", name: "芙宁娜" } as const;
  const kafka = { ...common, game: "hsr", id: "1005", name: "卡芙卡" } as const;
  const blizzard = { ...common, game: "gi", id: "14001", name: "冰风迷途的勇士" } as const;
  const hunter = { ...common, game: "hsr", id: "104", name: "密林卧雪的猎人" } as const;
  const pages = [
    { ...common, game: "gi", kind: "character", name: "角色", sampled: false, entries: [furina] },
    { ...common, game: "hsr", kind: "character", name: "角色", sampled: false, entries: [kafka] },
    { ...common, game: "gi", kind: "set", name: "圣遗物", sampled: false, entries: [blizzard] },
    { ...common, game: "hsr", kind: "set", name: "遗器套装", sampled: false, entries: [hunter] },
  ] as const;
  const catalog = { pages, stale: false };
  expect(findTraditionalEntries(catalog, "芙芙", "gi", "bare").map(({ entry }) => entry)).toEqual([furina]);
  expect(findTraditionalEntries(catalog, "亲妈", "hsr", "bare").map(({ entry }) => entry)).toEqual([kafka]);
  expect(findTraditionalEntries(catalog, "「亲·妈」", "hsr", "name").map(({ entry }) => entry)).toEqual([kafka]);
  expect(findTraditionalEntries(catalog, "冰套", "gi", "bare").map(({ entry }) => entry)).toEqual([blizzard]);
  expect(findTraditionalEntries(catalog, "冰套", "hsr", "bare").map(({ entry }) => entry)).toEqual([hunter]);
  expect(findTraditionalEntries(catalog, "芙芙", "hsr", "bare")).toEqual([]);
  expect(findTraditionalEntries(catalog, "冰套", "gi", "character")).toEqual([]);
  const sameName = { ...furina, id: "100", name: "芙芙" };
  const exact = { pages: [{ ...pages[0], entries: [furina, sameName] }], stale: false };
  expect(findTraditionalEntries(exact, "芙芙", "gi", "bare").map(({ entry }) => entry)).toEqual([sameName]);
});

test("星见雅旧全名只指向绝区零的雅，保留原索引名与精确名称优先级", () => {
  const entry = { game: "zzz", id: "1091", name: "雅", version: "3.3", rarity: "S级", path: "items/1091.json" } as const;
  const page = { game: "zzz", kind: "character", name: "角色", version: "3.3", sampled: false, entries: [entry] } as const;
  const snapshot = { pages: [page], stale: false };
  expect(findCharacters(snapshot, "星见雅", "zzz")).toEqual([entry]);
  expect(findTraditionalEntries(snapshot, "星见雅", "zzz", "name").map(({ entry }) => entry)).toEqual([entry]);
  expect(findTraditionalEntries(snapshot, "雅", "zzz", "name").map(({ entry }) => entry)).toEqual([entry]);
  expect(findTraditionalEntries(snapshot, "星见雅", "zzz", "equipment")).toEqual([]);
  expect(findTraditionalEntries(snapshot, "星见雅", "gi", "name")).toEqual([]);
  expect(findTraditionalEntries(snapshot, "星见", "zzz", "name")).toEqual([]);
  const distinct = { ...entry, id: "2000", name: "星见雅" };
  const withExact = { pages: [{ ...page, entries: [entry, distinct] }], stale: false };
  expect(findTraditionalEntries(withExact, "星见雅", "zzz", "name").map(({ entry }) => entry)).toEqual([distinct]);
});

test("安比的全名和零号安比的旧写法分别只返回对应身份", () => {
  const anby = { game: "zzz", id: "1011", name: "安比", version: "3.3", rarity: "A级", path: "items/1011.json" } as const;
  const soldierZero = { ...anby, id: "1381", name: "零号·安比", rarity: "S级", path: "items/1381.json" };
  const page = { game: "zzz", kind: "character", name: "角色", version: "3.3", sampled: false, entries: [anby, soldierZero] } as const;
  const catalog = { pages: [page], stale: false };
  for (const [query, entry] of [["安比", anby], ["安比·德玛拉", anby], ["安比德玛拉", anby],
    ["零号·安比", soldierZero], ["零号安比", soldierZero]] as const) {
    expect(findTraditionalEntries(catalog, query, "zzz", "name").map(({ entry }) => entry)).toEqual([entry]);
    expect(findCharacters(catalog, query)).toEqual([entry]);
  }
  expect(findTraditionalEntries(catalog, "零号", "zzz", "name")).toEqual([]);
  expect(findTraditionalEntries(catalog, "安比德玛拉", "hsr", "name")).toEqual([]);
});

test("猫又与妮可的旧全名和书写变体只匹配对应角色", () => {
  const neko = { game: "zzz", id: "1021", name: "猫又", version: "3.3", rarity: "S级", path: "items/1021.json" } as const;
  const nicole = { ...neko, id: "1031", name: "妮可", rarity: "A级", path: "items/1031.json" };
  const page = { game: "zzz", kind: "character", name: "角色", version: "3.3", sampled: false, entries: [neko, nicole] } as const;
  const catalog = { pages: [page], stale: false };
  for (const [queries, entry] of [[["猫又", "猫宫又奈", "猫宫 又奈"], neko], [["妮可", "妮可·德玛拉", "妮可德玛拉"], nicole]] as const) {
    for (const query of queries) {
      expect(findTraditionalEntries(catalog, query, "zzz", "name").map(({ entry }) => entry)).toEqual([entry]);
      expect(findCharacters(catalog, query)).toEqual([entry]);
    }
  }
  expect(findTraditionalEntries(catalog, "猫宫", "zzz", "name")).toEqual([]);
  expect(findTraditionalEntries(catalog, "妮可·德玛拉", "gi", "name")).toEqual([]);
});

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

test("快照目录切换后，在途详情与图库沿用原索引的目录", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-atlas-switch-"));
  try {
    const character = {
      version: "2", recordCount: 1,
      records: { "1": { id: "1", name: "角色甲", path: "items/one.json" } },
    };
    const map = JSON.stringify({ games: { zzz: { locales: { zh: { pages: { character } } } } } });
    const oldRoot = join(directory, "old", "data");
    const newRoot = join(directory, "new", "data");
    for (const [root, rank] of [[oldRoot, 3], [newRoot, 4]] as const) {
      await mkdir(join(root, "items"), { recursive: true });
      await writeFile(join(root, "map.json"), map);
      await writeFile(join(root, "items", "one.json"), JSON.stringify({
        meta: { gameId: "zzz", pageId: "character", recordId: "1", version: "2" },
        content: { list: { rank } },
      }));
    }
    const active = join(directory, "current");
    const candidate = join(directory, "candidate");
    await symlink(oldRoot, active, "dir");
    const catalog = createAtlasCatalog(active);
    const oldEntry = findCharacters(await catalog.read(), "角色甲")[0]!;
    await symlink(newRoot, candidate, "dir");
    await rename(candidate, active);
    const newEntry = findCharacters(await catalog.read(), "角色甲")[0]!;
    expect(newEntry).not.toBe(oldEntry);
    expect(await catalog.characterRarity(oldEntry)).toBe("A级");
    expect(await catalog.characterRarity(newEntry)).toBe("S级");
    expect(catalog.assetRoot(oldEntry)).toBe(await realpath(oldRoot));
    expect(catalog.assetRoot(newEntry)).toBe(await realpath(newRoot));
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

test("敌人按游戏和 ID 索引，保留同名变体及身份匹配的详情", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-monster-"));
  try {
    const record = (id: string, name: string, file: string) => ({ id, name, path: `items/${file}.json` });
    const page = (...rows: ReturnType<typeof record>[]) => ({ version: "1", recordCount: rows.length,
      records: Object.fromEntries(rows.map((row) => [row.id, row])) });
    const game = (pages: object) => ({ locales: { zh: { pages } } });
    await mkdir(join(root, "items"));
    await writeFile(join(root, "map.json"), JSON.stringify({ games: {
      gi: game({ monster: page(record("51", "样例敌人", "gi")) }),
      hsr: game({ monster: page(record("62", "样例敌人", "hsr"), record("63", "样例敌人", "hsr-variant")),
        monstervalue: page(record("64", "仅数值的条目", "stats")) }),
      zzz: game({ monster: page(record("62", "另一只敌人", "zzz")) }),
    } }));
    const detail = (file: string, gameId: string, recordId: string, name: string, version = "1") => writeFile(join(root, "items", `${file}.json`),
      JSON.stringify({ meta: { gameId, recordId, pageId: "monster", version, images: [
        { fieldPath: "icon", status: "downloaded", placeholder: false, localPath: "gallery/gi/../invalid.webp" },
        { fieldPath: "detail.icon", status: "downloaded", placeholder: true, localPath: "gallery/gi/placeholder.webp" },
        { fieldPath: "detail.monster_info.51.icon", status: "downloaded", placeholder: false, localPath: "gallery/gi/original.webp" },
        { fieldPath: "icon", status: "downloaded", placeholder: false, localPath: "gallery/gi/later.webp" },
      ] },
        content: { list: { desc: "English list fallback" }, detail: { name, desc: "简体中文<color=#AABBCC>敌人</color>。\\n后续。" } } }));
    await detail("gi", "gi", "51", "样例敌人");
    await detail("hsr", "hsr", "62", "样例敌人", "2");
    await detail("hsr-variant", "hsr", "63", "另一个条目");
    await detail("zzz", "zzz", "62", "另一只敌人");
    const catalog = createAtlasCatalog(root);
    const snapshot = await catalog.read();
    expect(findMonsters(snapshot, "样例敌人").map(({ game, id }) => `${game}/${id}`)).toEqual(["gi/51", "hsr/62", "hsr/63"]);
    expect(findMonsters(snapshot, "仅数值的条目")).toEqual([]);
    expect(findMonsters(snapshot, "６２", "zzz").map(({ name }) => name)).toEqual(["另一只敌人"]);
    expect(findTraditionalEntries(snapshot, "样例敌人", "gi", "name").map(({ kind }) => kind)).toEqual(["monster"]);
    expect(findTraditionalEntries(snapshot, "样例敌人", "gi", "equipment")).toEqual([]);
    expect(findTraditionalEntries(snapshot, "样例", "gi", "name")).toEqual([]);
    const original = findMonsters(snapshot, "51", "gi")[0]!;
    expect(await catalog.monsterDetails(original)).toEqual({ game: "gi", name: "样例敌人", version: "1",
      description: "简体中文敌人。\n后续。", artwork: "gallery/gi/original.webp" });
    expect(await catalog.monsterDescription(original)).toBe("简体中文敌人。\n后续。");
    const noIcon = await catalog.monsterDetails(findMonsters(snapshot, "62", "zzz")[0]!);
    expect(noIcon?.description).toBe("简体中文敌人。\n后续。");
    expect(noIcon?.artwork).toBeUndefined();
    for (const id of ["62", "63"]) expect(await catalog.monsterDescription(findMonsters(snapshot, id, "hsr")[0]!)).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("通用图鉴只纳入旧幽境危战分类，保留其他挑战的专属入口", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-leyline-"));
  try {
    const page = (id: string, name: string) => ({ version: "7.2.52", recordCount: 1,
      records: { [id]: { id, name, path: `items/${id}.json` } } });
    await writeFile(join(root, "map.json"), JSON.stringify({ games: { gi: { locales: { zh: { pages: {
      leyline: page("5269013", "幽境样例"), tower: page("125", "深渊样例"),
    } } } } } }));
    const catalog = await createAtlasCatalog(root).read();
    expect(catalog.pages.map(({ challengeMode }) => challengeMode?.id)).toEqual(["tower", "leyline"]);
    expect(findTraditionalEntries(catalog, "5269013", "gi")[0]?.entry.name).toBe("幽境样例");
    expect(findTraditionalEntries(catalog, "幽境样例", "gi", "name")[0]?.entry.id).toBe("5269013");
    expect(findTraditionalEntries(catalog, "幽境", "gi", "name")).toEqual([]);
    expect(findTraditionalEntries(catalog, "125", "gi")).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("裸装备入口读取在原位覆写、原子替换和发布指针换代后刷新索引", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-atlas-equipment-cache-"));
  try {
    const stamp = new Date("2026-01-01T00:00:00.000Z");
    const root = join(directory, "data");
    const file = join(root, "map.json");
    const createMap = async (path: string, name: string) => {
      const weapon = { version: "1", recordCount: 1,
        records: { one: { id: "1", name, path: "items/one.json" } } };
      await writeFile(path, JSON.stringify({ games: { gi: { locales: { zh: { pages: { weapon } } } } } }));
      await utimes(path, stamp, stamp);
    };
    const query = async (name: string) => {
      const current = await catalog.readForEquipmentShortcut();
      expect(current.stale).toBe(false);
      const matches = findTraditionalEntries(current, name, "gi", "weapon");
      expect(matches.map(({ entry }) => entry.name)).toEqual([name]);
      return current.pages;
    };
    await mkdir(root);
    await createMap(file, "刀剑甲");
    const catalog = createAtlasCatalog(root, directory);
    const first = await query("刀剑甲");
    expect(await query("刀剑甲")).toBe(first);

    const original = await stat(file, { bigint: true });
    await createMap(file, "刀剑乙");
    const overwritten = await stat(file, { bigint: true });
    expect([overwritten.ino, overwritten.size, overwritten.mtimeNs]).toEqual([original.ino, original.size, original.mtimeNs]);
    expect(await query("刀剑乙")).not.toBe(first);

    const candidate = join(root, "candidate.json");
    await createMap(candidate, "刀剑丙");
    await rename(candidate, file);
    expect((await stat(file, { bigint: true })).ino).not.toBe(original.ino);
    expect(await query("刀剑丙")).toBe((await catalog.read()).pages);

    const published = join(directory, "snapshots", "1", "data");
    await mkdir(published, { recursive: true });
    await createMap(join(published, "map.json"), "刀剑丁");
    await symlink("snapshots/1/data", join(directory, "current"), "dir");
    await query("刀剑丁");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
