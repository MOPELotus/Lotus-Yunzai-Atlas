import { expect, test } from "bun:test";
import { normalizeAbyss } from "./abyss-data.ts";

const entry = { game: "gi", id: "125", name: "凌振之月", path: "", rarity: "", version: "7.2.52" } as const;
const content = {
  list: { live_begin: "2026-11-16 04:00:00", live_end: "2026-12-16 03:59:59" },
  detail: {
    leyline: { name: "凌振之月", desc: "<color=#F39000>释放冲击波</color>。" },
    floor: {
      "9": {
        buff: ["角色造成的星扩散伤害提升50%。", "(test)怪物血量提升100%。"],
        room: { "1": { level: 72, type: "TOWER_COND_CHALLENGE_LEFT_TIME_MORE_THAN", cond: [[2, 60], [2, 180], [2, 300]],
          first: [{ id: 25130101, name: "持戟羽骑士", hp: 47951.875900800005 }],
          second: [{ id: 25130101, name: "持戟羽骑士" }] } },
      },
      "11": { room: { "1": { level: 88, type: "TOWER_COND_LEFT_HP_GREATER_THAN",
        cond: [[233899003, 3024, 20], [233899003, 3024, 40], [233899003, 3024, 60]], first: [], second: [] } } },
      "12": { first_half_buff: "月结晶伤害提升75%。", second_half_buff: "队伍中所有角色的元素精通提升200点。",
        room: { "2": { type: "unknown", cond: [[2, 180]] } } },
    },
  },
};
const lookup = async () => ({ name: "持戟羽骑士", hp: 4, description: "同 ID 简介。" });

test("abyss retains the verified room conditions, source HP and absent lineups", async () => {
  const icon = "gallery/gi/UI_MonsterIcon_Human_Girl_Vila_Glaive.webp";
  const images = [{ status: "downloaded", placeholder: false, fieldPath: "detail.floor.9.room.1.first.0.icon", localPath: icon }];
  const data = await normalizeAbyss(entry, content, images, lookup, true);
  expect(data?.name).toBe("当期深境螺旋 · 凌振之月");
  expect(data?.effects).toEqual([
    { title: "渊月祝福", description: "释放冲击波。" },
    { title: "第9层", description: "角色造成的星扩散伤害提升50%。" },
    { title: "第12层上半", description: "月结晶伤害提升75%。" },
    { title: "第12层下半", description: "队伍中所有角色的元素精通提升200点。" },
  ]);
  expect(data?.rooms.map(({ name, goal, level }) => [name, goal, level])).toEqual([
    ["9-1", "剩余时间目标 60秒 / 180秒 / 300秒", 72],
    ["11-1", "防守目标剩余生命值 20% / 40% / 60%", 88],
    ["12-2", "星级条件待核对", undefined],
  ]);
  expect(data?.rooms[0]?.sides[0]?.enemies[0]).toEqual({
    name: "持戟羽骑士", artwork: icon, hp: 47951.875900800005, description: "同 ID 简介。",
  });
  expect(data?.rooms[0]?.sides[1]?.enemies[0]?.hp).toBeUndefined();
  expect(data?.rooms[1]?.sides).toEqual([{ name: "上半", enemies: [] }, { name: "下半", enemies: [] }]);
});

test("the official date conflict is distinguishable from an ordinary export window", async () => {
  const flags = await Promise.all([
    normalizeAbyss({ ...entry, id: "126" }, { ...content, list: {
      live_begin: "2027-01-16 04:00:00", live_end: "2027-02-16 03:59:59",
    } }, [], lookup),
    normalizeAbyss({ ...entry, id: "20100" }, { ...content, list: { begin: "2026-11-17 04:00:00",
      end: "2026-12-16 03:59:59" } }, [], lookup),
  ]);
  expect(flags.map((row) => [row?.window?.from, row?.scheduleConflict])).toEqual([["live", true], ["export", false]]);
});

test("凌振之月 125 仅补经核实的 11、12 层空半场，保留源阵容和其他轮换", async () => {
  const verified = {
    ...content,
    detail: {
      ...content.detail,
      open: content.list.live_begin,
      close: content.list.live_end,
      leyline: { ...content.detail.leyline, icon: "UI_TowerBlessing_106" },
      floor: {
        "11": { room: {
          "1": { level: 88, first: [], second: [] },
          "2": { level: 90, first: [], second: [{ id: 26300401, name: "蕴光凛狼", hp: 125 }] },
          "3": { level: 92, first: [], second: [] },
        } },
        "12": { room: {
          "1": { level: 95, first: [], second: [] },
          "2": { level: 98, first: [], second: [] },
          "3": { level: 100, first: [], second: [] },
        } },
      },
    },
  };
  const lookup = async (id: string, name: string) => id === "20012301" ? undefined : ({ name, artwork: `gallery/gi/${id}.webp` });
  const data = await normalizeAbyss(entry, verified, [], lookup);
  expect(data?.rooms.map(({ sides }) => sides.map(({ enemies }) =>
    enemies.map(({ name, count }) => [name, count])))).toEqual([
    [[["嗥狼追猎者", 1], ["牙兽狂徒", 1], ["遗迹龙兽·地巡", 1]], [["深黯钓客", 12]]],
    [[["苍遒的木灵长", 1], ["幼嫩的分节树", 2], ["嵌合蝎尾怪", 1], ["嵌合鳄蹄兽", 2]], [["蕴光凛狼", undefined]]],
    [[["冰结镜映体", 4]], [["荒野狂狩士", 1]]],
    [[["历经百战的虹彩史莱姆", 1]], [["浪涛锚定者", 1]]],
    [[["霜夜巡天灵主", 1]], [["游雪的护刃", 1]]],
    [[["蕴光月守宫", 1]], [["恒常机关阵列", 1]]],
  ]);
  expect(data?.rooms[0]?.sides[1]?.enemies[0]).toMatchObject({ artwork: "gallery/gi/22140101.webp", count: 12 });
  expect(data?.rooms[0]?.sides[1]?.enemies[0]?.hp).toBeUndefined();
  expect(data?.rooms[1]?.sides[1]?.enemies[0]?.hp).toBe(125);
  expect(data?.rooms[3]?.sides[0]?.enemies[0]).toEqual({
    name: "历经百战的虹彩史莱姆", count: 1, artwork: undefined, description: undefined,
  });
  expect(data?.rooms[3]?.sides[1]?.enemies[0]?.artwork).toBe("gallery/gi/25134601.webp");
  const otherId = await normalizeAbyss({ ...entry, id: "124" }, verified, [], lookup);
  const otherDate = await normalizeAbyss(entry, { ...verified, list: { ...verified.list, live_end: "2026-12-17 03:59:59" } }, [], lookup);
  const otherVersion = await normalizeAbyss({ ...entry, version: "7.3" }, verified, [], lookup);
  for (const unchanged of [otherId, otherDate, otherVersion]) {
    expect(unchanged?.rooms[0]?.sides.flatMap(({ enemies }) => enemies)).toEqual([]);
  }
});
