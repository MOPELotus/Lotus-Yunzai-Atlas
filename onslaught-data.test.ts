import { expect, test } from "bun:test";
import type { AtlasEntry } from "./catalog.ts";
import { normalizeOnslaught } from "./onslaught-data.ts";

const entry: AtlasEntry = { game: "gi", id: "5269013", name: "幽境样例", version: "7.2.52", rarity: "", path: "items/onslaught.json" };
const enemy = { name: "样例强敌", desc: "敌人简介。", monster_buff_name_list: ["地脉机制"],
  monster_buff_desc_list: ["<color=#FFFFFF>概要。</color>"], monster_buff_detail_list: ["详尽说明。"], stats: { hp: null } };
const stage = (monster_level: number, desc: string) => ({ monster_level, difficulty_config: { desc_list: [desc] },
  level_config: { 7001: enemy } });
const levels = { 1: stage(109, "N6 规则。"), 2: stage(104, "N5 规则。"), 3: stage(99, "不要混入 N4。") };
const detail = { id: 5269013, name: entry.name, level: levels };
const list = { begin: "2026-11-03 10:00:00", end: "2026-12-01 03:59:59" };
const image = { fieldPath: "detail.level.1.level_config.7001.icon", localPath: "gallery/gi/boss.webp",
  status: "downloaded", placeholder: false };

test("幽境卡只取实证 N5/N6，按源 ID 合并同名强敌和两组机制", () => {
  const normalized = normalizeOnslaught(entry, { list, detail }, [image]);
  expect(normalized).toEqual({ name: entry.name, version: entry.version,
    window: { ...list, from: "export" }, artwork: image.localPath,
    rules: [{ difficulty: "N5", description: "N5 规则。" }, { difficulty: "N6", description: "N6 规则。" }],
    enemies: [{ name: enemy.name, artwork: image.localPath, mechanics: "地脉机制：概要。\n地脉机制详情：详尽说明。", variants: [
      { difficulty: "N5", level: 105, description: "敌人简介。\n地脉机制：概要。\n地脉机制详情：详尽说明。" },
      { difficulty: "N6", level: 110, description: "敌人简介。\n地脉机制：概要。\n地脉机制详情：详尽说明。" },
    ] }],
  });
  expect(normalizeOnslaught(entry, { list, detail }, [{ ...image, localPath: "gallery/gi/../bad.webp" }])?.artwork).toBeUndefined();
});

test("未匹配源身份或缺少其中一个确认的难度时保留文本回退", () => {
  expect(normalizeOnslaught({ ...entry, id: "5269014" }, { list, detail }, [])).toBeUndefined();
  expect(normalizeOnslaught(entry, { list, detail: { ...detail, level: { 1: levels[1], 3: levels[3] } } }, [])).toBeUndefined();
  expect(normalizeOnslaught(entry, { list, detail: { ...detail, level: { ...levels, 4: levels[2] } } }, [])).toBeUndefined();
});
