import { expect, test } from "bun:test";
import { challengeModes, findChallengeMode, readChallengeFacts } from "./challenges.ts";

test("挑战模式先核对游戏，保留实装时间并区分导出窗口", () => {
  const mode = findChallengeMode("hsr", "混沌");
  expect(mode?.id).toBe("maze");
  expect(findChallengeMode("gi", "混沌回忆")).toBeUndefined();
  const list = {
    begin: "2026-11-01 04:00:00", end: "2026-12-02 04:00:00",
    live_begin: "2026-11-15 04:00:00", live_end: "2026-11-29 04:00:00",
  };
  const facts = readChallengeFacts(mode!, { list, detail: [{ name: "测试关" }, { name: null }] });
  expect(facts.window).toEqual({ begin: list.live_begin, end: list.live_end, from: "live" });
  expect(facts.sections).toEqual([{ label: "来源关卡", items: ["测试关"], count: 2 }]);
  expect(readChallengeFacts(mode!, { list: { ...list, live_end: "2026-11-31 04:00:00" } }).window)
    .toEqual({ begin: list.begin, end: list.end, from: "export" });
  expect(readChallengeFacts(mode!, { list: {
    begin: "2000-01-01 04:00:00", end: "2000-02-01 04:00:00",
  } }).window).toBeUndefined();
});

test("异相仲裁拆分骑士与王棋，危局按子模式保留敌人", () => {
  const arbitration = challengeModes.find(({ id }) => id === "maze_peak")!;
  const strict = readChallengeFacts(arbitration, { detail: {
    pre_level: [{ name: "骑士甲" }, { name: "骑士乙" }, { name: "骑士丙" }],
    boss_level: { name: "王棋关" },
  } });
  expect(strict.window).toBeUndefined();
  expect(strict.sections).toEqual([
    { label: "骑士", count: 3, items: ["骑士甲", "骑士乙", "骑士丙"] },
    { label: "王棋", count: 1, items: ["王棋关"] },
  ]);
  const assault = challengeModes.find(({ id }) => id === "boss")!;
  expect(readChallengeFacts(assault, { detail: {
    modes: [
      { zone_type: 1001, zone: { one: { name: "试炼一" }, two: { name: "试炼二" } } },
      { zone_type: 1002, zone: { one: { name: "绝境敌人" } } },
    ],
  } }).sections).toEqual([
    { label: "试炼", count: 2, items: ["试炼一", "试炼二"] },
    { label: "绝境", count: 1, items: ["绝境敌人"] },
  ]);
});
