import { expect, test } from "bun:test";
import { fictionMode } from "./challenges.ts";
import { normalizeStarrailChallenge } from "./starrail-challenge-data.ts";

test("虚构长卡区分战意规则、可选增益和实际关卡阵容", async () => {
  const entry = { game: "hsr", id: "2027", name: "取象为文", path: "", rarity: "", version: "4.7.52" } as const;
  const contents = {
    list: { live_begin: "2026-10-19 04:00:00", live_end: "2026-11-30 04:00:00",
      begin: "2026-08-24 04:00:01", end: "2026-10-27 04:00:00" },
    detail: {
      id: 2027,
      buff: { name: null, desc: null, param: [] },
      sub_option: [
        { name: "施加负面效果", desc: "额外累积#1[i]点战意值，每敌最多#2[i]次。", param: [1, 10] },
        { name: "战熄潮平", desc: "效果抵抗降低#1[i]%。", param: [0.3] },
      ],
      option: [{ name: "触技", desc: "终结技和追加攻击伤害提高#1[i]%。", param: [0.4] }],
      level: [
        { id: 20274, name: "取象为文其四", damage_type1: ["Physical", "Quantum"],
          challenge: [{ name: "获得#1分", param: 60000 }],
          npc_monster_id_list1: [9999989],
          infinite_list1: { "99": { monster_group_id_list: [9999999] } },
          event_id_list1: [{ level: 85, monster_list: [{ monster0: 403301002, monster1: 403301002 }] }] },
        { id: 20275, pre_id: 20274, challenge_special: { name: "获得#1分", param: 99000 },
          event_id_list: [{ level: 85, monster_list: [{ monster0: 302401204 }] }] },
      ],
    },
  };
  const hit = new Map([["403301002", "兽群之力的具象"], ["302401204", "银骑士"]]);
  const seen: string[] = [];
  const result = await normalizeStarrailChallenge(entry, fictionMode, contents, [], async (id) => {
    seen.push(id);
    return { name: hit.get(id)! };
  }, true);

  expect(result?.name).toBe("当期虚构叙事 · 取象为文");
  expect(result?.window).toEqual({ from: "live", begin: "2026-10-19 04:00:00", end: "2026-11-30 04:00:00" });
  expect(result?.effects).toEqual([
    { name: "施加负面效果", description: "额外累积1点战意值，每敌最多10次。" },
    { name: "战熄潮平", description: "效果抵抗降低30%。" },
  ]);
  expect(result?.optional).toEqual([{ name: "触技", description: "终结技和追加攻击伤害提高40%。" }]);
  expect(seen).toEqual(["403301002", "302401204"]);
  expect(result?.rooms.map(({ name, goals }) => [name, goals])).toEqual([
    ["取象为文其四", ["获得60000分"]],
    ["取象为文其四 · 星启模式", ["额外目标 获得99000分"]],
  ]);
  expect(result?.rooms[0]?.sides[0]?.weaknesses).toEqual(["物理", "量子"]);
  expect(result?.rooms[0]?.sides[1]?.enemies).toEqual([]);
});
