import { expect, test } from "bun:test";
import { chaosMode } from "./challenges.ts";
import { normalizeStarrailChallenge } from "./starrail-challenge-data.ts";

const entry = { game: "hsr", id: "1036", name: "物竞天择", version: "4.7.52", path: "", rarity: "" } as const;
const list = { live_begin: "2026-11-02 04:00:00", live_end: "2026-12-14 04:00:00" };
const desc = "施放终结技时获得<unbreak>#1[i]</unbreak>个笑点。\\n额外回合计入#2[i]笑点。";
const level = { id: 5512, name: "物竞天择其十二", desc, param: [5, 20], damage_type1: ["Physical", "Fire"],
  challenge: [{ name: "剩余<unbreak>#1[i]</unbreak>轮以上", param: 20 }, { name: "没有角色无法战斗" }],
  event_id_list1: [{ level: 95, monster_list: [{ monster0: 4064010 }] }],
};
const special = { id: 5513, pre_id: 5512, challenge: [{ name: "无法战斗角色不超过<unbreak>#1[i]</unbreak>名" }],
  challenge_special: { name: "获得3星，且剩余#1[i]轮以上", param: 33 },
  event_id_list: [{ level: 95, monster_list: [{ monster0: 4064010 }] }],
};
const lookup = async () => ({ name: "裁定者" });

test("混沌保留普通关卡共同紊流与星启额外目标，缺数值不猜", async () => {
  const data = await normalizeStarrailChallenge(entry, chaosMode, { list, detail: [level, special] }, [], lookup, true);
  expect(data?.name).toBe("当期混沌回忆 · 物竞天择");
  expect(data?.window).toEqual({ from: "live", begin: list.live_begin, end: list.live_end });
  expect(data?.effects).toEqual([{ name: "常规关卡", description: "施放终结技时获得5个笑点。\n额外回合计入20笑点。" }]);
  expect(data?.rooms.map(({ name, description, goals }) => [name, description, goals])).toEqual([
    ["物竞天择其十二", undefined, ["剩余20轮以上", "没有角色无法战斗"]],
    ["物竞天择其十二 · 星启模式", "", ["无法战斗角色不超过（数值待核对）名", "额外目标 获得3星，且剩余33轮以上"]],
  ]);
  expect(data?.rooms[0]?.sides[0]?.weaknesses).toEqual(["物理", "火"]);
  expect(data?.rooms[1]?.sides[0]?.enemies[0]?.level).toBe(95);
});

test("同一记录的层特有效果继续留在对应关卡", async () => {
  const first = { ...level, id: 5501, name: "其一", param: [4, 10] };
  const data = await normalizeStarrailChallenge(entry, chaosMode, { list, detail: [first, level] }, [], lookup);
  expect(data?.effects).toEqual([]);
  expect(data?.rooms.map(({ description }) => description)).toEqual([
    "施放终结技时获得4个笑点。\n额外回合计入10笑点。", "施放终结技时获得5个笑点。\n额外回合计入20笑点。",
  ]);
});
