import { expect, test } from "bun:test";
import { arbitrationMode, findCurrentChallenge, readChallengeFacts } from "./challenges.ts";
import { normalizeStarrailChallenge } from "./starrail-challenge-data.ts";

test("异相仲裁保留三个骑士、王棋和绝境，区分关卡词条与绝境可选增益", async () => {
  const entry = { game: "hsr", id: "11", name: "隐藏关卡", path: "", rarity: "", version: "4.7.52" } as const;
  const stage = [{ release: true, level: 95, monster_list: [{ monster0: 5034010 }],
    invasion: { level: 4, monster_list: [{ monster_id: 5033010 }] } }];
  const content = {
    list: { zh: "隐藏关卡" },
    detail: {
      id: 11,
      pre_level: [
        { id: 1101, name: "骑士（一）", event_id_list: stage, damage_type: ["Quantum", "Imaginary"],
          tag_list: [{ name: "血嗜", desc: "每回合损失#1[i]点生命值。", param: [500] }] },
        { id: 1102, name: "骑士（二）" },
        { id: 1103, name: "骑士（三）" },
      ],
      boss_level: { id: 1104, name: "将杀王棋", damage_type: ["Fire"] },
      boss_config: { hard_name: "将杀王棋•绝境", event_id_list: [{ level: 120, monster_list: [{ monster0: 5034010 }] }],
        tag_list: [{ name: "残秽+", desc: "敌方伤害提高#1[i]%。", param: [0.15] }],
        buff_list: [{ name: "无上喜悦", desc: "回复#1[i]%能量。", param: [0.02] }] },
    },
  };
  const enemy = async (id: string) => ({
    name: id === "5034010" ? "堕神之血•亚婆离" : "渊兽原体",
    artwork: "gallery/hsr/monsterfigure/Monster_5034010.webp",
    description: id === "5034010" ? "同源说明。" : "...",
  });
  const result = await normalizeStarrailChallenge(entry, arbitrationMode, content, [], enemy, true);
  expect(result?.name).toBe("异相仲裁 · 隐藏关卡");
  expect(result?.window).toBeUndefined();
  expect(result?.rooms.map(({ name }) => name)).toEqual(["骑士（一）", "骑士（二）", "骑士（三）", "将杀王棋", "将杀王棋•绝境"]);
  expect(result?.rooms[0]?.description).toBe("血嗜：每回合损失500点生命值。");
  expect(result?.rooms[0]?.sides[0]?.weaknesses).toEqual(["量子", "虚数"]);
  expect(result?.rooms[0]?.sides[0]?.enemies.map(({ name, level }) => [name, level])).toEqual([
    ["堕神之血•亚婆离", 95], ["渊兽原体", undefined],
  ]);
  expect(result?.rooms[0]?.sides[0]?.enemies[1]?.description).toBeUndefined();
  expect(result?.rooms[4]).toMatchObject({ description: "残秽+：敌方伤害提高15%。",
    optional: [{ name: "无上喜悦", description: "回复2%能量。" }], sides: [{ weaknesses: [], enemies: [{ level: 120 }] }] });
  expect(await findCurrentChallenge(arbitrationMode, [entry], async () => readChallengeFacts(arbitrationMode, content),
    Date.parse("2026-11-19T12:00:00+08:00"))).toBeUndefined();
  expect(await normalizeStarrailChallenge({ ...entry, id: "12" }, arbitrationMode, content, [], enemy)).toBeUndefined();
});
