import { expect, test } from "bun:test";
import { normalizeDeadlyAssault } from "./deadly-assault-data.ts";

const entry = { game: "zzz", id: "690491", name: "试炼", path: "", rarity: "", version: "3.4.4" } as const;
const list = { live_begin: "2026-11-06 04:00:00", live_end: "2026-11-20 03:59:59" };
const optional = { "1": { title: "灼曜", desc: "火属性异常积蓄效率提升10%。" } };
const room = (id: number, name: string) => ({
  monster_list: { "12": { id, name, stats: { hp: 52569962.279999994 } } },
  monster_weakness: { "201": "火属性", "204": "风属性" },
  monster_resistance: { "200": "物理" },
});
const trial = {
  zone_type: 1001,
  zone: {
    "69049101": { name: "僭越者", monster_level: 70, goal_type: 2, s_rank_goal: 20000, a_rank_goal: 14000, b_rank_goal: 6000,
      layer_buff: { "1": { title: "", desc: "适合<IconMap:Icon_AvatarClass_Anomaly><color=#FFAF2C>[异常]</color>。" } },
      layer_room: { "690491011": room(40012, "僭越者") }, selectable_buff: optional },
  },
};
const intensity = {
  zone_type: 1002,
  zone: {
    "69049201": { name: "复写体·猎血清道夫", monster_level: 70, goal_type: 2,
      s_rank_goal: 30000, a_rank_goal: 20000, b_rank_goal: 10000,
      layer_buff: {
        "1": { title: "", desc: "触发<Term:2000003></Term>后获得<color=#FFAF2C>500操作得分</color>。" },
        "2": { title: "(Test1)TBD", desc: "内部试验参数" },
      },
      layer_room: { "690492011": room(40003, "复写体·猎血清道夫") }, selectable_buff: optional },
  },
};
const lookup = async (_: string, name: string) => ({ name, hp: 1 });

test("危局在同条分出试炼和绝境，保留同房间名、原图、分数和单位", async () => {
  const art = "gallery/zzz/Monster_ClonedBlackWolf.webp";
  const images = [{ status: "downloaded", placeholder: false,
    fieldPath: "detail.modes.0.zone.69049201.layer_room.690492011.monster_list.12.image", localPath: art }];
  const result = await normalizeDeadlyAssault(entry, { list, detail: { id: 690491, modes: [intensity, trial] } }, images, lookup, true);
  expect(result?.name).toBe("当期危局强袭战");
  expect(result?.window?.from).toBe("live");
  expect(result?.commonOptional).toEqual([{ name: "灼曜", description: "火属性异常积蓄效率提升10%。" }]);
  expect(result?.divisions.map(({ name, encounters }) => [name, encounters[0]?.name, encounters[0]?.goals])).toEqual([
    ["试炼", "僭越者", "S 20000 分 · A 14000 分 · B 6000 分"],
    ["绝境", "复写体·猎血清道夫", "S 30000 分 · A 20000 分 · B 10000 分"],
  ]);
  expect(result?.divisions[0]?.encounters[0]?.mechanics).toEqual([{ name: "", description: "适合[异常]。" }]);
  const round = result?.divisions[1]?.encounters[0];
  expect(round?.mechanics).toEqual([{ name: "", description: "触发〔术语待核对〕后获得500操作得分。" }]);
  expect(round?.rooms[0]).toMatchObject({ weaknesses: ["火属性", "风属性"], resistances: ["物理"],
    enemies: [{ name: "复写体·猎血清道夫", artwork: art, hp: 52569962.279999994 }] });
});

test("只有试炼的旧数据保留原实际范围，导出时间保持预览", async () => {
  const exported = { begin: "2026-10-21 04:00:00", end: "2026-12-18 03:59:59" };
  const data = await normalizeDeadlyAssault(entry, { list: exported, detail: { id: 690491, modes: [trial] } }, [], lookup);
  expect(data?.window?.from).toBe("export");
  expect(data?.divisions.map(({ name }) => name)).toEqual(["试炼"]);
  expect(await normalizeDeadlyAssault(entry, { list, detail: { id: 690492, modes: [trial] } }, [], lookup)).toBeUndefined();
});
