import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtlasCatalog, findTraditionalEntries, type Game, type TraditionalLookup } from "./catalog.ts";
import { abyssMode, apocalypseMode, fictionMode } from "./challenges.ts";
import { parseDatedChallengeShortcut, parseEquipmentShortcut, parseGluedLookup, parseRoleShortcut } from "./traditional.ts";

test("装备旧指令识别宿主标准化前后的游戏前缀，忽略分项与个人查询", () => {
  for (const [game, query, commands] of [
    ["gi", "西风剑", ["#西风剑图鉴", "#原神西风剑图鉴"]],
    ["hsr", "锋镝", ["*锋镝图鉴", "#星铁锋镝图鉴", "#星穹铁道锋镝图鉴", "#崩坏星穹铁道锋镝图鉴"]],
    ["zzz", "深海访客", ["%深海访客图鉴", "％深海访客图鉴", "#绝区零深海访客图鉴"]],
  ] as const) {
    for (const command of commands) expect(parseEquipmentShortcut(command)).toEqual({ game, query });
  }
  for (const command of ["#图鉴", "#星铁图鉴", "#西风剑攻略图鉴", "#芙宁娜练度统计图鉴", "#芙宁娜命座图鉴",
    "*卡芙卡星魂", "％艾莲影画图鉴", "#当期深渊", "*本期末日", "%防卫战", "#123图鉴", "#１２３图鉴"]) {
    expect(parseEquipmentShortcut(command)).toBeUndefined();
  }
});

test("旧显式入口接受紧连名称，预留状态、维护和帮助指令", () => {
  for (const command of ["#图鉴西风剑", "图鉴西风剑", "#Lotus图鉴西风剑", "lotus图鉴西风剑", "荷花图鉴西风剑"]) {
    expect(parseGluedLookup(command)).toBe("西风剑");
  }
  for (const command of ["#荷花图鉴状态", "Lotus图鉴帮助", "#图鉴更新", "荷花图鉴检查更新", "图鉴全量更新", "#图鉴重置",
    "#更新图鉴", "#Lotus检查图鉴更新", "#全量更新图鉴", "#荷花重置图鉴", "#lotus清空图鉴"]) {
    expect(parseGluedLookup(command)).toBeUndefined();
    expect(parseEquipmentShortcut(command)).toBeUndefined();
  }
});

test("旧深境螺旋日期语法以中国服当天中午查询，只接带图鉴后缀的本期和上期", () => {
  const at = Date.parse("2026-11-16T12:00:00+08:00");
  for (const command of [
    "#2026年11月16日本期深渊图鉴", "#2026.11.16当期深境螺旋图鉴",
    "#原神2026/11/16本期深渊图鉴",
  ]) expect(parseDatedChallengeShortcut(command)).toEqual({ mode: abyssMode, period: "本期", at });
  expect(parseDatedChallengeShortcut("#2026-11-16上期深境螺旋图鉴")).toEqual({ mode: abyssMode, period: "上期", at });
  expect(parseDatedChallengeShortcut("#2026年2月29日本期深渊图鉴")).toEqual({ mode: abyssMode, period: "本期", at: undefined });
  expect(parseDatedChallengeShortcut("#2024年2月29日本期深渊图鉴")).toEqual({
    mode: abyssMode, period: "本期", at: Date.parse("2024-02-29T12:00:00+08:00"),
  });
  for (const command of [
    "#本期深渊图鉴", "#2026-11-16本期深渊", "#2026-11-16下期深渊图鉴",
    "#2026-11-16本期幻想图鉴", "*2026-11-16本期深渊图鉴",
  ]) expect(parseDatedChallengeShortcut(command)).toBeUndefined();
});

test("末日幻影日期图鉴仅接受旧星铁前缀，保持个人和其他游戏入口", () => {
  const at = Date.parse("2026-10-26T12:00:00+08:00");
  for (const command of ["*2026年10月26日本期末日图鉴", "#星铁2026/10/26当期末日幻影图鉴"]) {
    expect(parseDatedChallengeShortcut(command)).toEqual({ mode: apocalypseMode, period: "本期", at });
  }
  expect(parseDatedChallengeShortcut("#星铁2026-10-26上期末日图鉴")).toEqual({ mode: apocalypseMode, period: "上期", at });
  for (const command of ["#2026-10-26本期末日图鉴", "#原神2026-10-26本期末日图鉴", "*2026-10-26本期末日",
    "*2026-10-26下期末日图鉴", "*2026-10-26本期异相图鉴"]) {
    expect(parseDatedChallengeShortcut(command)).toBeUndefined();
  }
});

test("虚构叙事恢复旧星铁日期写法，拒绝裸日期查询与错误前缀", () => {
  const at = Date.parse("2026-10-19T12:00:00+08:00");
  for (const command of ["*2026年10月19日本期虚构图鉴", "#星铁2026/10/19当期虚构叙事图鉴"]) {
    expect(parseDatedChallengeShortcut(command)).toEqual({ mode: fictionMode, period: "本期", at });
  }
  expect(parseDatedChallengeShortcut("#星铁2026-10-19上期虚构叙事图鉴")).toEqual({ mode: fictionMode, period: "上期", at });
  for (const command of ["*2026-10-19本期虚构", "#2026-10-19本期虚构图鉴", "%2026-10-19本期虚构图鉴",
    "*2026-10-19下期虚构图鉴", "*2026-10-19本期混沌图鉴"]) {
    expect(parseDatedChallengeShortcut(command)).toBeUndefined();
  }
});

test("角色分项可省略前缀，带游戏前缀时仍须与分项一致", () => {
  for (const [game, query, commands] of [
    ["gi", "芙宁娜", ["芙宁娜命座", "芙宁娜命座图鉴", "#芙宁娜命座", "#原神芙宁娜命座图鉴"]],
    ["hsr", "卡芙卡", ["卡芙卡星魂", "*卡芙卡星魂", "#星穹铁道卡芙卡星魂图鉴"]],
    ["zzz", "艾莲·乔", ["艾莲·乔影画", "艾莲·乔影画图鉴", "％艾莲·乔影画", "#绝区零艾莲·乔影画图鉴"]],
  ] as const) {
    for (const command of commands) expect(parseRoleShortcut(command)).toEqual({ game, query });
  }
  expect(parseRoleShortcut("芙宁娜天赋")).toEqual({ query: "芙宁娜" });
  expect(parseRoleShortcut("#芙宁娜天赋")).toEqual({ game: "gi", query: "芙宁娜" });
  expect(parseRoleShortcut("%雅影画")).toEqual({ game: "zzz", query: "雅" });
  for (const command of ["#角色天赋", "角色天赋", "芙宁娜攻略命座", "*卡芙卡影画", "#绝区零艾莲星魂", "芙宁娜图鉴", "雅影画"]) {
    expect(parseRoleShortcut(command)).toBeUndefined();
  }
});

function page(...records: { id: string; name: string }[]) {
  return { version: "1", recordCount: records.length, records: Object.fromEntries(records.map((entry) =>
    [entry.id, { ...entry, path: `items/${entry.id}.json` }])) };
}

test("显式旧搜索择优且保留同名结果，装备捷径只认指定游戏的完整名称", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-traditional-"));
  try {
    await mkdir(join(root, "items"));
    await writeFile(join(root, "items/202.json"), JSON.stringify({
      meta: { gameId: "gi", pageId: "artifact", recordId: "202", version: "1" },
      content: { list: { set: { two: { name: { zh: "西风剑" } } } } },
    }));
    await writeFile(join(root, "map.json"), JSON.stringify({
      games: {
        gi: { locales: { zh: { pages: {
          character: page({ id: "10", name: "西风剑客" },
            { id: "10000005-2", name: "旅行者" }, { id: "10000007-3", name: "旅行者" }),
          weapon: page({ id: "100", name: "西风剑" }, { id: "101", name: "余响 · 旧曲" }),
          artifact: page({ id: "202", name: "索引名应由详情修正" }),
        } } } },
        hsr: { locales: { zh: { pages: { lightcone: page({ id: "300", name: "西风剑" }) } } } },
        zzz: { locales: { zh: { pages: { bangboo: page({ id: "400", name: "企鹅布" }) } } } },
      },
    }));
    const snapshot = await createAtlasCatalog(root).read();
    const hits = (query: string, game?: Game, mode?: TraditionalLookup) =>
      findTraditionalEntries(snapshot, query, game, mode).map(({ entry, kind }) => [entry.game, kind, entry.id]);
    expect(hits("西风剑")).toEqual([["gi", "equipment", "100"], ["gi", "set", "202"], ["hsr", "equipment", "300"]]);
    expect(hits("100")).toEqual([["gi", "equipment", "100"]]);
    expect(hits("西风剑客")).toEqual([["gi", "character", "10"]]);
    expect(hits("10000005-2", "gi")).toEqual([["gi", "character", "10000005-2"]]);
    expect(hits("１００００００７－３", "gi")).toEqual([["gi", "character", "10000007-3"]]);
    expect(hits("100000052", "gi")).toEqual([]);
    expect(hits("10000005-2", "hsr")).toEqual([]);
    expect(hits("旅行者", "gi")).toEqual([["gi", "character", "10000005-2"], ["gi", "character", "10000007-3"]]);
    expect(hits("企鹅布")).toEqual([["zzz", "bangboo", "400"]]);
    expect(hits("西风剑", "hsr", "equipment")).toEqual([["hsr", "equipment", "300"]]);
    expect(hits("西风剑", "gi", "equipment")).toEqual([["gi", "equipment", "100"], ["gi", "set", "202"]]);
    for (const name of ["西风", "100", "西风剑客", "企鹅布", "余响旧曲"]) expect(hits(name, "gi", "equipment")).toEqual([]);
    expect(hits("余响 · 旧曲", "gi", "equipment")).toEqual([["gi", "equipment", "101"]]);
    expect(hits("西风", undefined, "name")).toEqual([]);
    expect(hits("西风剑客", undefined, "name")).toEqual([["gi", "character", "10"]]);
    expect(hits("西风剑", undefined, "character")).toEqual([]);
    expect(hits("西风剑", "gi", "character")).toEqual([]);
    expect(hits("西风剑客", undefined, "character")).toEqual([["gi", "character", "10"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
