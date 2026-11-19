import { expect, test } from "bun:test";
import { findNextShiyu, readChallengeFacts, shiyuMode } from "./challenges.ts";
import { normalizeShiyu } from "./shiyu-data.ts";

const entry = { game: "zzz", name: "剧变节点", id: "62061", path: "", rarity: "", version: "3.4.4" } as const;
const buff = { title: "岚火燎天", desc: "<color=#FFFFFF>[强攻]</color>特性的代理人攻击力提升35%。" };
const roster = { "11482": { id: 100271, name: "恶毒打手", stats: { hp: 252937.4925 } } };
const mainRoom = { monster_weakness: { 201: "火属性" }, monster_resistance: { 203: "电属性" }, monster_list: roster };
const content = {
  list: { zh: "剧变节点", sort: 1, live_begin: "2026-11-13 04:00:00", live_end: "2026-11-27 03:59:59" },
  detail: { id: 62061, zone: {
    "6206101": { name: "剧变节点第一防线", stage_num: 1, monster_level: 50, goal_type: 0,
      s_rank_goal: 300, a_rank_goal: 420, b_rank_goal: 600, layer_buff: { "1": buff },
      layer_room: { "62061011": mainRoom, "62061012": { monster_list: {} } } },
    "6206105": { name: "", stage_num: 5, child: [62061051], goal_type: 3, s_rank_goal: 1270001003, layer_buff: { "1": buff } },
    "62061051": { name: "房间一", stage_num: 5, monster_level: 70, goal_type: 2,
      s_rank_goal: 25000, a_rank_goal: 16000, b_rank_goal: 8000, layer_room: { "62061051": mainRoom } },
  } },
};

test("式舆保留对应半场的原图、实值及第五防线独立房间，不显示综合条件 ID", async () => {
  const icon = "gallery/zzz/Monster_ViciousStrikerPro.webp";
  const images = [{ status: "downloaded", placeholder: false,
    fieldPath: "detail.zone.6206101.layer_room.62061011.monster_list.11482.image", localPath: icon }];
  const shiyu = await normalizeShiyu(entry, content, images, async () => ({ name: "恶毒打手", hp: 1 }), "current");
  expect(shiyu?.name).toBe("当期式舆防卫战 · 剧变节点");
  expect(shiyu?.effects).toEqual([{ name: "岚火燎天", description: "[强攻]特性的代理人攻击力提升35%。" }]);
  expect(shiyu?.defenses.map(({ name, goals }) => [name, goals])).toEqual([
    ["剧变节点第一防线", "S 300 秒 · A 420 秒 · B 600 秒"], ["第五防线", "综合评级条件待核对"],
  ]);
  expect(shiyu?.defenses[0]?.effects).toEqual(["岚火燎天"]);
  expect(shiyu?.defenses[0]?.rooms[0]).toMatchObject({
    name: "上半", weaknesses: ["火属性"], resistances: ["电属性"],
    enemies: [{ name: "恶毒打手", hp: 252937.4925, artwork: icon }],
  });
  expect(shiyu?.defenses[0]?.rooms[1]).toMatchObject({ name: "下半", enemies: [] });
  expect(shiyu?.defenses[1]?.challenges[0]).toMatchObject({
    name: "房间一", level: 70, goals: "S 25000 分 · A 16000 分 · B 8000 分",
    rooms: [{ name: "", enemies: [{ name: "恶毒打手" }] }],
  });
});

test("式舆下期须从唯一当前轮换无缝衔接，不接受导出、其他节点或中途冲突", async () => {
  const row = (id: string, begin: string, end: string, type: "live" | "export" | "other" = "live") => ({
    id, facts: readChallengeFacts(shiyuMode, { list: {
      zh: type === "other" ? "奇袭节点" : "剧变节点", sort: type === "other" ? 4 : 1,
      ...(type === "export" ? { begin, end } : { live_begin: begin, live_end: end }),
    } }),
  });
  const current = row("62061", "2026-11-13 04:00:00", "2026-11-27 03:59:59");
  const next = row("62062", "2026-11-27 04:00:00", "2026-12-11 03:59:59");
  const preview = row("620631", "2026-11-27 04:00:00", "2026-12-18 03:59:59", "export");
  const other = row("61003", "2026-11-27 04:00:00", "2026-12-18 03:59:59", "other");
  const late = row("future", "2026-12-10 04:00:00", "2026-12-18 03:59:59");
  const choose = (...rows: ReturnType<typeof row>[]) =>
    findNextShiyu(rows, async ({ facts }) => facts, Date.parse("2026-11-19T12:00:00+08:00"));
  expect((await choose(current, next, preview, other))?.entry.id).toBe("62062");
  expect(await choose(current, preview, other)).toBeUndefined();
  expect(await choose(current, next, late)).toBeUndefined();
  expect(await choose(current, late)).toBeUndefined();
  expect(await choose(next, preview)).toBeUndefined();
  expect(await choose(current, next, { ...next, id: "dupe" })).toBeUndefined();
  expect(await choose(current, next, { ...current, id: "dupe-current" })).toBeUndefined();
});
