import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtlasCatalog, findTraditionalEntries, type Game, type TraditionalLookup } from "./catalog.ts";
import { abyssMode, apocalypseMode, chaosMode, deadlyAssaultMode, fictionMode, shiyuMode, theaterMode } from "./challenges.ts";
import { parseBareNameShortcut, parseChallengeShortcut, parseEquipmentShortcut, parseGluedLookup, parseRoleShortcut, traditionalAtlasEvent } from "./traditional.ts";

test("装备旧指令识别宿主标准化前后的游戏前缀，忽略分项与个人查询", () => {
  for (const [game, query, commands] of [
    ["gi", "西风剑", ["#西风剑图鉴", "#原神西风剑图鉴"]],
    ["gi", "123", ["#123图鉴", "#原神123图鉴"]],
    ["gi", "１２３", ["#１２３图鉴"]],
    ["hsr", "锋镝", ["*锋镝图鉴", "#星铁锋镝图鉴", "#星穹铁道锋镝图鉴", "#崩坏星穹铁道锋镝图鉴"]],
    ["zzz", "深海访客", ["%深海访客图鉴", "％深海访客图鉴", "#绝区零深海访客图鉴"]],
  ] as const) {
    for (const command of commands) expect(parseEquipmentShortcut(command)).toEqual({ game, query });
  }
  for (const command of ["#图鉴", "#星铁图鉴", "#西风剑攻略图鉴", "#芙宁娜练度统计图鉴", "#芙宁娜命座图鉴",
    "*卡芙卡星魂", "％艾莲影画图鉴", "#当期深渊", "*本期末日", "%防卫战", "#1图鉴", "#１图鉴"]) {
    expect(parseEquipmentShortcut(command)).toBeUndefined();
  }
});

test("裸装备捷径沿用各游戏前缀，带图鉴和角色分项仍归原入口", () => {
  for (const [game, query, commands] of [
    ["gi", "西风剑", ["#西风剑", "#原神西风剑"]],
    ["hsr", "锋镝", ["*锋镝", "#星穹铁道锋镝"]],
    ["zzz", "深海访客", ["%深海访客", "％深海访客", "#绝区零深海访客"]],
  ] as const) {
    for (const command of commands) expect(parseBareNameShortcut(command)).toEqual({ game, query });
  }
  for (const command of ["西风剑", "#西风剑图鉴", "#更新图鉴", "#123", "#星铁１２３", "*卡芙卡星魂", "%深海访客攻略"]) {
    expect(parseBareNameShortcut(command)).toBeUndefined();
  }
});

test("显式入口接受紧连名称，预留状态、维护和帮助指令", () => {
  for (const command of ["#图鉴西风剑", "图鉴西风剑"]) {
    expect(parseGluedLookup(command)).toBe("西风剑");
  }
  for (const command of ["#Lotus图鉴西风剑", "lotus图鉴西风剑", "荷花图鉴西风剑"]) {
    expect(parseGluedLookup(command)).toBeUndefined();
  }
  for (const command of ["#图鉴状态", "图鉴帮助", "#图鉴更新", "图鉴检查更新", "图鉴全量更新", "#图鉴重置",
    "#更新图鉴", "#检查图鉴更新", "#全量更新图鉴", "#重置图鉴", "#清空图鉴"]) {
    expect(parseGluedLookup(command)).toBeUndefined();
    expect(parseEquipmentShortcut(command)).toBeUndefined();
  }
});

test("挑战日期别名沿用中国服中午，保留明确的游戏、所属类别和期次", () => {
  for (const [mode, period, date, commands] of [
    [abyssMode, "本期", "2026-11-16", ["#2026年11月16日本期深渊", "#2026.11.16当期深境螺旋图鉴", "#原神2026/11/16本期深渊图鉴"]],
    [apocalypseMode, "本期", "2026-10-26", ["*2026-10-26本期末日", "#星铁2026/10/26当期末日幻影图鉴"]],
    [fictionMode, "本期", "2026-10-19", ["*2026年10月19日本期虚构图鉴", "#星铁2026/10/19当期虚构叙事图鉴"]],
    [chaosMode, "上期", "2026-07-06", ["*2026.7.6上期混沌回忆图鉴", "#星铁2026-7-6上期忘却之庭"]],
    [theaterMode, "本期", "2026-11-16", ["#2026-11-16本期幻想图鉴", "#2026-11-16本期剧诗"]],
    [deadlyAssaultMode, "本期", "2026-11-20", ["%2026-11-20本期危局", "％2026-11-20本期强袭图鉴", "#绝区零2026-11-20本期危局强袭战"]],
    [shiyuMode, "下期", "2026-11-20", ["%2026-11-20下期防卫战", "#绝区2026-11-20下期式舆"]],
  ] as const) {
    const at = Date.parse(`${date}T12:00:00+08:00`);
    for (const command of commands) expect(parseChallengeShortcut(command)).toEqual({ mode, period, at, invalidDate: false });
  }
  expect(parseChallengeShortcut("#2026年2月29日本期深渊")).toEqual({
    mode: abyssMode, period: "本期", at: undefined, invalidDate: true,
  });
  expect(parseChallengeShortcut("#2024年2月29日本期深渊图鉴")).toEqual({
    mode: abyssMode, period: "本期", at: Date.parse("2024-02-29T12:00:00+08:00"), invalidDate: false,
  });
  for (const command of ["*2026-11-16本期深渊图鉴", "#2026-10-26本期末日", "%2026-07-06本期混沌图鉴",
    "#2026-11-16深渊", "#2026-11-16当期深渊攻略", "%深渊", "#深渊", "#当期深渊", "*本期末日", "%上期防卫战"]) {
    expect(parseChallengeShortcut(command)).toBeUndefined();
  }
});

test("原生图鉴路由把裸全名、日期和下期交给对应的公共查询，个人入口仍让行", async () => {
  const calls: unknown[][] = [];
  const byteLimits: (number | undefined)[] = [];
  const route = traditionalAtlasEvent(
    async (query, kind, game, delivery) => {
      byteLimits.push(delivery?.inlineImageByteLimit);
      calls.push([query, kind, game]);
      return "名称资料";
    },
    async (mode, period, at, delivery) => {
      byteLimits.push(delivery?.inlineImageByteLimit);
      calls.push([mode.id, period, at]);
      return "挑战资料";
    },
  );
  expect(route).toMatchObject({ name: "图鉴旧指令", event: "message", priority: 5000 });
  expect(route.rule.pattern.test("*卡芙卡")).toBe(true);
  const replies: unknown[] = [];
  const command = (msg: string) => route.rule.run({ msg, reply: (value) => replies.push(value) });
  for (const msg of ["#芙宁娜", "#星铁卡芙卡", "#绝区零艾莲·乔", "#冰风迷途的勇士", "*太空封印站", "％啄木鸟电音"])
    await command(msg);
  for (const msg of ["#2026年11月16日本期深渊", "#星铁2026-10-26本期末日", "%2026-11-20本期危局",
    "#下期幻想", "*下期末日", "%下期防卫战", "#下期深渊", "%2026-11-20下期防卫战"])
    await command(msg);
  expect(calls).toEqual([
    ["芙宁娜", "bare", "gi"], ["卡芙卡", "bare", "hsr"], ["艾莲·乔", "bare", "zzz"],
    ["冰风迷途的勇士", "bare", "gi"], ["太空封印站", "bare", "hsr"], ["啄木鸟电音", "bare", "zzz"],
    ["tower", "本期", Date.parse("2026-11-16T12:00:00+08:00")], ["maze_boss", "本期", Date.parse("2026-10-26T12:00:00+08:00")],
    ["boss", "本期", Date.parse("2026-11-20T12:00:00+08:00")], ["rolecombat", "下期", undefined],
    ["maze_boss", "下期", undefined], ["shiyu", "下期", undefined], ["tower", "下期", undefined],
    ["shiyu", "下期", Date.parse("2026-11-20T12:00:00+08:00")],
  ]);
  expect(replies).toEqual([...Array(6).fill("名称资料"), ...Array(8).fill("挑战资料")]);
  for (const msg of ["#深渊", "#当期深渊", "*本期末日", "%防卫战", "#绝区零上期危局", "#芙宁娜面板",
    "*卡芙卡排行", "#芙宁娜攻略", "#芙宁娜练度统计", "%最强艾莲", "#刷新cookie", "#全量更新图鉴"])
    expect(await command(msg)).toBe(false);
  await command("#2026年2月29日本期深渊");
  expect(replies.at(-1)).toBe("日期无效，请输入有效日期，支持 YYYY-MM-DD 或 YYYY年M月D日。");
  expect(calls).toHaveLength(14);
  expect(byteLimits).toEqual(Array(14).fill(undefined));
  await route.rule.run({ msg: "#芙宁娜", inlineImageByteLimit: 16 * 1024 * 1024, reply: () => undefined });
  await route.rule.run({ msg: "#2026年11月16日本期深渊", inlineImageByteLimit: 16 * 1024 * 1024, reply: () => undefined });
  expect(byteLimits.slice(-2)).toEqual([16 * 1024 * 1024, 16 * 1024 * 1024]);
});

test("原生图鉴按网关的转发结果处理整册，转发未知时不会重发各页", async () => {
  const nodes = ["整册", { type: "image", file: Uint8Array.of(1) }] as const;
  const route = traditionalAtlasEvent(async () => ({ type: "forward", nodes }), async () => "挑战");
  for (const receipt of [true, false, "unknown"] as const) {
    const replies: unknown[] = [];
    const handled = await route.rule.run({
      msg: "#芙宁娜", reply: (value) => replies.push(value),
      async forward(contents) {
        expect(contents).toBe(nodes);
        if (receipt === "unknown") throw new Error("网关回执丢失");
        return receipt;
      },
    });
    expect(handled).toBe(true);
    expect(replies).toEqual(receipt === true ? [] : receipt === false ? [...nodes] : ["合并转发结果未确认，请在聊天中核对。"]);
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
    for (const [id, name] of [["202", "西风剑"], ["14001", "冰风迷途的勇士"]]) {
      await writeFile(join(root, `items/${id}.json`), JSON.stringify({
        meta: { gameId: "gi", pageId: "artifact", recordId: id, version: "1" },
        content: { list: { set: { two: { name: { zh: name } } } } },
      }));
    }
    await writeFile(join(root, "map.json"), JSON.stringify({
      games: {
        gi: { locales: { zh: { pages: {
          character: page({ id: "10", name: "西风剑客" },
            { id: "10000005-2", name: "旅行者" }, { id: "10000007-3", name: "旅行者" }),
          weapon: page({ id: "100", name: "西风剑" }, { id: "101", name: "余响 · 旧曲" },
            { id: "11505", name: "磐岩结绿" }),
          artifact: page({ id: "202", name: "索引名应由详情修正" }, { id: "14001", name: "另一组件名称" }),
        } } } },
        hsr: { locales: { zh: { pages: { lightcone: page({ id: "300", name: "西风剑" }, { id: "21018", name: "舞！舞！舞！" }) } } } },
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
    expect(hits("西风剑", "gi", "weapon")).toEqual([["gi", "equipment", "100"]]);
    expect(hits("西风剑", "gi", "bare")).toEqual([["gi", "equipment", "100"]]);
    expect(hits("西风剑客", "gi", "bare")).toEqual([["gi", "character", "10"]]);
    expect(hits("西风剑客", "hsr", "bare")).toEqual([]);
    expect(hits("冰风迷途的勇士", "gi", "bare")).toEqual([["gi", "set", "14001"]]);
    expect(hits("冰封迷途的勇士", "gi", "bare")).toEqual([["gi", "set", "14001"]]);
    expect(hits("西风", "gi", "bare")).toEqual([]);
    expect(hits("企鹅布", "zzz", "bare")).toEqual([]);
    expect(hits("绿剑", "gi", "weapon")).toEqual([["gi", "equipment", "11505"]]);
    expect(hits("舞舞舞", "hsr", "weapon")).toEqual([["hsr", "equipment", "21018"]]);
    expect(hits("舞舞舞", "gi", "weapon")).toEqual([]);
    for (const name of ["西风", "100", "西风剑客", "企鹅布"]) expect(hits(name, "gi", "weapon")).toEqual([]);
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
