import { expect, test } from "bun:test";
import { challengeModes, findChallengeMode, findCurrentStarRailChallenge, readChallengeFacts, type ChallengeMode } from "./challenges.ts";

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

function row(id: string, liveBegin?: string, liveEnd?: string) {
  return { id, list: { live_begin: liveBegin, live_end: liveEnd,
    begin: "2026-11-09 04:00:00", end: "2026-12-18 04:00:00" } };
}

const choose = async (mode: ChallengeMode, rows: readonly ReturnType<typeof row>[], time: string) =>
  (await findCurrentStarRailChallenge(mode, rows, async (entry) => readChallengeFacts(mode, entry), Date.parse(time)))?.entry.id;

test("旧快照三类轮换使用中国服时间，结束边界排他并跳过未来或导出窗口", async () => {
  const chaos = findChallengeMode("hsr", "混沌")!;
  const fiction = findChallengeMode("hsr", "虚构")!;
  const shadow = findChallengeMode("hsr", "末日")!;
  const chaosRows = [row("1036", "2026-11-02 04:00:00", "2026-12-14 04:00:00"),
    row("1037", "2026-12-14 04:00:00", "2027-01-25 04:00:00"), row("1038")];
  const fictionRows = [row("2027", "2026-10-19 04:00:00", "2026-11-30 04:00:00"),
    row("2028", "2026-11-30 04:00:00", "2027-01-11 04:00:00"), row("2029")];
  const shadowRows = [row("3021", "2026-10-05 04:00:00", "2026-11-16 04:00:00"),
    row("3022", "2026-11-16 04:00:00", "2026-12-28 04:00:00"), row("3024")];
  expect(await choose(chaos, chaosRows, "2026-11-19T12:00:00+08:00")).toBe("1036");
  expect(await choose(fiction, fictionRows, "2026-11-19T12:00:00+08:00")).toBe("2027");
  expect(await choose(shadow, shadowRows, "2026-11-19T12:00:00+08:00")).toBe("3022");
  expect(await choose(chaos, chaosRows, "2026-12-13T19:59:59Z")).toBe("1036");
  expect(await choose(chaos, chaosRows, "2026-12-13T20:00:00Z")).toBe("1037");
  expect(await choose(shadow, shadowRows, "2026-12-28T04:00:00+08:00")).toBeUndefined();
});

test("重叠、部分 live、导出及异相仲裁都不能选定本期", async () => {
  const chaos = findChallengeMode("hsr", "混沌")!;
  const time = "2024-01-22T04:00:01+08:00";
  const overlap = [row("1009", "2023-12-25 04:00:00", "2024-02-05 04:00:00"),
    row("1010", "2024-01-22 04:00:00", "2024-03-04 04:00:00")];
  expect(await choose(chaos, overlap, time)).toBeUndefined();
  expect(await choose(chaos, [row("1038"), row("1010", "2026-11-15 04:00:00")], "2026-11-19T04:00:00+08:00"))
    .toBeUndefined();
  expect(await choose(findChallengeMode("hsr", "异相仲裁")!, overlap, time)).toBeUndefined();
});
