import { expect, test } from "bun:test";
import { findCurrentChallenge, readChallengeFacts, theaterMode } from "./challenges.ts";
import { normalizeTheater } from "./theater-data.ts";

const entry = { game: "gi", id: "31", name: "31", path: "", rarity: "", version: "7.2.52" } as const;
const exportDates = { begin: "2026-10-29 04:00:00", end: "2026-12-02 16:00:00" };
const liveDates = { live_begin: "2026-11-01 04:00:00", live_end: "2026-12-01 03:59:59" };
const content = {
  list: { ...exportDates, ...liveDates },
  detail: {
    avatar_config: {
      element_list: [3, 5, 8, 0, 99, 3],
      buff_avatar_list: [{ id: 10000060, desc: "<color=#f39001>获得幻境祝福。</color>" }],
      invite_avatar_list: [10000035, 10000150],
    },
    difficulty_config: {
      "3": { room: { "1": { monster_level: 70 } } },
      "5": {
        minimum_avatar_level: 70, boss_max_room_number: 10,
        room: { "3": { monster_level: 89, title: "翠翎恐蕈", desc: "说明。\\n下一句。",
          monster_preview_list: [{ id: 26110101, name: "翠翎恐蕈", hp: 123 }] }, "1": { monster_level: 84 } },
        hard_room: { "7": { monster_level: 99 }, "4": { monster_level: 95 } },
      },
    },
  },
};
const characters = new Map([["10000060", { name: "夜兰" }], ["10000035", { name: "七七" }]]);
const lookup = {
  character: async (id: string) => characters.get(id),
  enemy: async () => ({ name: "翠翎恐蕈", description: "同 ID 敌人图鉴介绍。" }),
};

test("theater data preserves official lineup mapping, source order and the exact boss icon", async () => {
  const iconPath = "gallery/gi/UI_MonsterIcon_Fungus_Raptor.webp";
  const images = [
    { status: "downloaded", placeholder: false, fieldPath: "detail.difficulty_config.5.room.3.monster_preview_list.0.icon", localPath: iconPath },
  ];
  const data = await normalizeTheater(entry, content, images, lookup, true);
  expect(data?.name).toBe("当期幻想真境剧诗");
  expect(data?.difficulty).toBe("月谕");
  expect(data?.window).toEqual({ from: "live", begin: liveDates.live_begin, end: liveDates.live_end });
  expect(data?.elements.map(({ name }) => name)).toEqual(["水", "雷", "岩", "元素代码 99（待核对）"]);
  expect(data?.groups.map(({ name, cards }) => [name, cards.map((card) => card.name)])).toEqual([
    ["开幕角色", ["夜兰"]], ["特邀角色", ["七七", "角色 ID 10000150（待核对）"]], ["首领阵容", ["翠翎恐蕈"]],
  ]);
  expect(data?.groups.slice(0, 2).map(({ cards }) => cards.map(({ id }) => id))).toEqual([[10000060], [10000035, 10000150]]);
  expect(data?.groups[0]?.cards[0]?.description).toBe("获得幻境祝福。");
  expect(data?.acts.map(({ name, subtitle }) => [name, subtitle])).toEqual([
    ["第一幕", "Lv84"], ["第三幕", "Lv89 · 翠翎恐蕈"], ["圣牌一", "Lv95"], ["圣牌二", "Lv99"],
  ]);
  expect(data?.acts[1]?.description).toBe("说明。 下一句。");
  expect(data?.acts[1]?.enemies).toEqual([{ id: 26110101, name: "翠翎恐蕈", artwork: iconPath, description: "同 ID 敌人图鉴介绍。" }]);
});

test("theater selects the live row over overlapping exports and only previews an export by ID", async () => {
  const preview = { ...entry, id: "33", name: "33" };
  const exported = { ...content, list: exportDates };
  const readFacts = async ({ id }: typeof entry | typeof preview) => readChallengeFacts(theaterMode, id === "33" ? exported : content);
  const selected = await findCurrentChallenge(theaterMode, [entry, preview], readFacts, Date.parse("2026-11-19T00:00:00+08:00"));
  expect(selected?.entry.id).toBe("31");
  expect(await findCurrentChallenge(theaterMode, [entry, preview], readFacts, Date.parse("2026-12-01T04:00:00+08:00"))).toBeUndefined();
  const data = await normalizeTheater(preview, exported, [], lookup);
  expect(data?.window?.from).toBe("export");
  expect(data?.name).toBe("幻想真境剧诗");
});

test("11 月实装月谕第八幕预览为空时补丘丘萨满和游戏内等级", async () => {
  const room = {
    monster_level: 94, title: "历经百战的丘丘萨满", desc: "破坏「美味汤锅」。",
  };
  const difficulty = content.detail.difficulty_config;
  const withAct = (preview: readonly unknown[] = []) => ({ ...content, detail: { ...content.detail,
    difficulty_config: { ...difficulty, "5": { ...difficulty["5"], room: {
      ...difficulty["5"].room, "8": { ...room, monster_preview_list: preview },
    } } },
  } });

  const released = await normalizeTheater(entry, withAct(), [], lookup);
  const sourceBoss = { name: room.title, artwork: "gallery/gi/verified/Churldric.png" };
  expect(released?.acts.find(({ name }) => name === "第八幕")).toMatchObject({
    subtitle: "Lv95 · 历经百战的丘丘萨满", enemies: [sourceBoss],
  });
  expect(released?.groups.find(({ name }) => name === "首领阵容")?.cards.map(({ name }) => name))
    .toEqual(["翠翎恐蕈", room.title]);

  const indexed = await normalizeTheater(entry, withAct([{ name: "上游敌人资料" }]), [], lookup);
  expect(indexed?.acts.find(({ name }) => name === "第八幕")?.enemies).toMatchObject([{ name: "上游敌人资料" }]);

  const preview = await normalizeTheater(entry, { ...withAct(), list: exportDates }, [], lookup);
  const other = await normalizeTheater({ ...entry, id: "32", name: "32" }, withAct(), [], lookup);
  for (const data of [preview, other]) {
    expect(data?.acts.find(({ name }) => name === "第八幕")).toMatchObject({
      subtitle: "Lv94 · 历经百战的丘丘萨满", enemies: [],
    });
  }
});

test("10 月实装月谕的两处空首领预览使用对应旧图鉴原图", async () => {
  const october = { ...entry, id: "30", name: "30", version: "7.2" };
  const list = { live_begin: "2026-10-01 04:00:00", live_end: "2026-11-01 03:59:59" };
  const sixth = { title: "历经百战的嵌合兽怪箭士", monster_level: 91, monster_preview_list: [] };
  const eighth = { title: "嵌合翼骏狮", monster_level: 94, monster_preview_list: [] };
  const raw = { list, detail: { difficulty_config: { "5": { room: {
    "6": sixth, "8": eighth, "9": eighth,
  } } } } };
  const data = await normalizeTheater(october, raw, [], lookup);
  expect(data?.acts.map(({ name, enemies }) => [name, enemies])).toEqual([
    ["第六幕", [{ name: sixth.title, artwork: "gallery/gi/UI_MonsterIcon_Volkodlak_Greyhound_Furiosa.webp" }]],
    ["第八幕", [{ name: eighth.title, artwork: "gallery/gi/UI_MonsterIcon_Chimera_Manticore.webp" }]],
    ["第九幕", []],
  ]);
  expect(data?.groups.find(({ name }) => name === "首领阵容")?.cards.map(({ name }) => name))
    .toEqual([sixth.title, eighth.title]);

  const indexed = await normalizeTheater(october, { ...raw, detail: { difficulty_config: { "5": { room: { "6": {
    ...sixth, monster_preview_list: [{ name: "源数据敌人" }],
  } } } } } }, [], lookup);
  expect(indexed?.acts[0]?.enemies).toMatchObject([{ name: "源数据敌人" }]);

  for (const unchanged of [
    normalizeTheater(october, { ...raw, list: { begin: list.live_begin, end: list.live_end } }, [], lookup),
    normalizeTheater(entry, raw, [], lookup),
    normalizeTheater(october, { ...raw, detail: { difficulty_config: { "4": { room: { "6": sixth } } } } }, [], lookup),
  ]) {
    expect((await unchanged)?.acts.every(({ enemies }) => !enemies.length)).toBe(true);
  }
});
