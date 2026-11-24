import { expect, test } from "bun:test";
import { abyssMode, apocalypseMode, challengeModes, chaosMode, deadlyAssaultMode, fictionMode, findAnnouncedChallengeNext,
  findChallengeMode, findCurrentChallenge, findNextOnslaught, findPreviousChallenge, hasChallengeRotation, onslaughtMode, readChallengeFacts,
  theaterMode, type ChallengeMode } from "./challenges.ts";
import { createArbitrationLookup, selectArbitrationId } from "./versioned-challenges.ts";

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

test("异相仲裁从正式游戏版本取一期，测试快照不能把下期提前变成本期", async () => {
  const mapping = { "4.5": [9], "4.6": [10], "4.7": [11], unknown: [12] };
  expect(selectArbitrationId("4.7.52", mapping, "current")).toBe("11");
  expect(selectArbitrationId("4.7.52", mapping, "previous")).toBe("10");
  expect(selectArbitrationId("4.7.52", mapping, "next")).toBe("12");
  expect(selectArbitrationId("4.7", { ...mapping, unknown: [12, 13] }, "next")).toBeUndefined();
  expect(selectArbitrationId("4.8", mapping, "current")).toBeUndefined();
  expect(selectArbitrationId("5.0", { ...mapping, "5.0": [12] }, "previous")).toBe("11");
  const lookup = createArbitrationLookup();
  expect(await lookup("4.8.50", "current", Date.parse("2026-11-24T12:00:00+08:00"))).toBe("11");
  expect(await lookup("4.7.52", "current", Date.parse("2026-11-10T12:00:00+08:00"))).toBe("10");
  expect(await lookup("4.7.52", "current", Date.parse("2026-11-11T08:00:00+08:00"))).toBeUndefined();
});

test("异相仲裁换版本后读取正式版和本地快照对应的期次表", async () => {
  let manifests = 0;
  const urls: string[] = [];
  const lookup = createArbitrationLookup(async () => {
    manifests++;
    return { hsr: { live: "5.0", latest: "5.1.52", available: ["5.0", "5.1.52"] } };
  }, async url => {
    urls.push(url);
    return Response.json({ "4.7": [11], "5.0": [12], "5.1": [13] });
  }, () => Date.parse("2027-01-08T00:00:00+08:00"));
  expect(await Promise.all([lookup("5.1.52", "current"), lookup("5.1.52", "next")])).toEqual(["12", "13"]);
  expect(manifests).toBe(1);
  expect(urls).toEqual(["https://static.nanoka.cc/hsr/5.1.52/peak/version.json"]);
  expect(await lookup("5.0", "previous")).toBe("11");
  expect(urls.at(-1)).toBe("https://static.nanoka.cc/hsr/5.0/peak/version.json");
});

test("幽境危战下期只提供相邻编号的预览，导出窗口不能改变本期", async () => {
  const current = row("5269013", "2026-11-11 10:00:00", "2026-12-23 09:59:59");
  const preview = row("5269014");
  const wrong = row("5269020");
  const at = Date.parse("2026-11-24T12:00:00+08:00");
  const facts = async (entry: typeof current) => readChallengeFacts(onslaughtMode, entry);
  expect((await findNextOnslaught([wrong, preview, current], facts, at))?.entry.id).toBe("5269014");
  expect(await findNextOnslaught([wrong, current], facts, at)).toBeUndefined();
  expect((await findCurrentChallenge(onslaughtMode, [preview, current], facts, at))?.entry.id).toBe("5269013");
});

test("幽境危战识别六种难度的历史数据，活动期间之外仍按记录查询", () => {
  expect(findChallengeMode("gi", "幽境危战")).toBe(onslaughtMode);
  expect(findChallengeMode("gi", "危战")).toBe(onslaughtMode);
  expect(findChallengeMode("gi", "地脉异常")).toBe(onslaughtMode);
  expect(findChallengeMode("hsr", "幽境")).toBeUndefined();
  expect(hasChallengeRotation(onslaughtMode)).toBe(true);
  const list = { begin: "2026-11-03 10:00:00", end: "2026-12-01 03:59:59" };
  const level = Object.fromEntries([39, 69, 89, 99, 104, 109].map((monster_level, index) => [101401 + index, { monster_level }]));
  expect(readChallengeFacts(onslaughtMode, { list, detail: { level } })).toMatchObject({
    window: { begin: list.begin, end: list.end, from: "export" },
    sections: [{ label: "难度配置", count: 6, items: ["N1", "N2", "N3", "N4", "N5", "N6"] }],
  });
});

function row(id: string, liveBegin?: string, liveEnd?: string, variant?: { sort: number; zh: string }) {
  return { id, list: { ...variant, live_begin: liveBegin, live_end: liveEnd,
    begin: "2026-11-09 04:00:00", end: "2026-12-18 04:00:00" } };
}

const choose = async (mode: ChallengeMode, rows: readonly ReturnType<typeof row>[], time: string) =>
  (await findCurrentChallenge(mode, rows, async (entry) => readChallengeFacts(mode, entry), Date.parse(time)))?.entry.id;

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

test("末日上期只选择唯一的紧邻实装窗口", async () => {
  const previous = row("3021", "2026-10-05 04:00:00", "2026-11-16 04:00:00");
  const current = row("3022", "2026-11-16 04:00:00", "2026-12-28 04:00:00");
  const exportOnly = { id: "导出窗", list: { begin: previous.list.live_begin, end: previous.list.live_end } };
  const choose = async (rows: readonly typeof exportOnly[], time = "2026-11-20T12:00:00+08:00") =>
    (await findPreviousChallenge(apocalypseMode, rows, async (entry) => readChallengeFacts(apocalypseMode, entry), Date.parse(time)))?.entry.id;
  const rows = [current, exportOnly, previous];
  expect(await choose(rows)).toBe("3021");
  expect(await choose(rows, "2026-11-15T19:59:59Z")).toBeUndefined();
  expect(await choose(rows, "2026-11-15T20:00:00Z")).toBe("3021");
  expect(await choose(rows, "2026-12-28T04:00:00+08:00")).toBeUndefined();
  expect(await choose([current, exportOnly])).toBeUndefined();
  expect(await choose([current, row("有空档", "2026-10-05 04:00:00", "2026-11-15 04:00:00")])).toBeUndefined();
  expect(await choose([...rows, { ...previous, id: "并列前期" }])).toBeUndefined();
  expect(await choose([...rows, { ...current, id: "并列当前" }])).toBeUndefined();
  expect(await choose([...rows, row("与前期重叠", "2026-10-01 04:00:00", "2026-11-15 04:00:00")])).toBeUndefined();
});

test("末日下期只预览公告对应的领航冥茫记录", async () => {
  const current = { ...row("3021", "2026-10-05 04:00:00", "2026-11-16 04:00:00"), name: "支配遗忘" };
  const next = { ...row("3022", "2026-11-16 04:00:00", "2026-12-28 04:00:00"), name: "领航冥茫" };
  const sameName = { ...row("3023", "2026-12-28 04:00:00", "2027-01-28 04:00:00"), name: next.name };
  const rows = [sameName, current, next];
  const select = async (time: string, entries = rows) =>
    (await findAnnouncedChallengeNext(apocalypseMode, entries, async (entry) => readChallengeFacts(apocalypseMode, entry), Date.parse(time)))?.entry.id;
  expect(await select("2026-11-16T03:59:59.999+08:00")).toBe("3022");
  expect(await select("2026-11-16T04:00:00+08:00")).toBeUndefined();
  expect(await select("2026-11-16T03:59:59.999+08:00", [current, { ...next, id: "3023" }])).toBeUndefined();
});

test("虚构上期沿中国服实装边界切换，覆盖中断时返回待核对", async () => {
  const earlier = row("2025", "2026-08-03 04:00:00", "2026-09-14 04:00:00");
  const previous = row("2026", "2026-09-14 04:00:00", "2026-10-19 04:00:00");
  const current = row("2027", "2026-10-19 04:00:00", "2026-11-30 04:00:00");
  const records = [current, earlier, previous];
  const select = async (time: string, entries = records) =>
    (await findPreviousChallenge(fictionMode, entries, async (entry) => readChallengeFacts(fictionMode, entry), Date.parse(time)))?.entry.id;
  expect(await select("2026-10-19T03:59:59+08:00")).toBe("2025");
  expect(await select("2026-10-19T04:00:00+08:00")).toBe("2026");
  expect(await select("2026-11-30T04:00:00+08:00")).toBeUndefined();
  expect(await select("2026-10-19T04:00:00+08:00", [current, earlier])).toBeUndefined();
});

test("虚构下期仅预览官网公告与正式实装窗口一致的相邻记录", async () => {
  const current = { ...row("2027", "2026-10-19 04:00:00", "2026-11-30 04:00:00"), name: "取象为文" };
  const next = { ...row("2028", "2026-11-30 04:00:00", "2027-01-11 04:00:00"), name: "虚事成理" };
  const undated = { ...row("2029"), name: "待核对" };
  const records = [current, undated, next];
  const select = async (entries = records, time = "2026-11-29T19:59:59Z") =>
    (await findAnnouncedChallengeNext(fictionMode, entries, async (entry) => readChallengeFacts(fictionMode, entry), Date.parse(time)))?.entry.id;
  expect(await select()).toBe("2028");
  expect(await select(records, "2026-11-29T20:00:00Z")).toBeUndefined();
  expect(await select([current, undated])).toBeUndefined();
  expect(await select([current, { ...next, name: "同 ID 错标题" }])).toBeUndefined();
  expect(await select([current, { ...next, list: { ...next.list, live_end: "2027-01-10 04:00:00" } }])).toBeUndefined();
  expect(await select([current, next, { ...next, id: "重复候选" }])).toBeUndefined();
  expect(await select([current, next, { ...undated, list: { ...undated.list,
    live_begin: "2027-01-10 04:00:00", live_end: "2027-02-11 04:00:00" } }])).toBeUndefined();
});

test("混沌上期识别相邻实装窗口，忽略只有导出时间的记录", async () => {
  const rows = [row("1031", "2026-04-13 04:00:00", "2026-05-25 04:00:00"),
    row("1032", "2026-05-25 04:00:00", "2026-07-06 04:00:00"),
    row("1033", "2026-07-06 04:00:00", "2026-08-17 04:00:00"),
    { id: "仅导出", list: { begin: "2026-09-01 04:00:00", end: "2026-11-02 04:00:00" } },
    row("1036", "2026-11-02 04:00:00", "2026-12-14 04:00:00")];
  const select = async (time: string) =>
    (await findPreviousChallenge(chaosMode, rows, async (entry) => readChallengeFacts(chaosMode, entry), Date.parse(time)))?.entry.id;
  expect(await select("2026-07-06T03:59:59+08:00")).toBe("1031");
  expect(await select("2026-07-06T04:00:00+08:00")).toBe("1032");
  expect(await select("2026-11-20T12:00:00+08:00")).toBeUndefined();
});

test("混沌下期只返回与公告相符的漆黑残响预览", async () => {
  const current = { ...row("1036", "2026-11-02 04:00:00", "2026-12-14 04:00:00"), name: "物竞天择" };
  const next = { ...row("1037", "2026-12-14 04:00:00", "2027-01-25 04:00:00"), name: "漆黑残响" };
  const undated = { ...row("1038"), name: "待核对" };
  const records = [current, next, undated];
  const select = async (entries = records, time = "2026-12-13T19:59:59Z") =>
    (await findAnnouncedChallengeNext(chaosMode, entries, async (entry) => readChallengeFacts(chaosMode, entry), Date.parse(time)))?.entry.id;
  expect(await select()).toBe("1037");
  expect(await select(records, "2026-12-13T20:00:00Z")).toBeUndefined();
  expect(await select([current, { ...next, list: { ...next.list, live_end: "2027-01-26 04:00:00" } }])).toBeUndefined();
  expect(await select([current, undated])).toBeUndefined();
});

test("幻想剧诗上期在中国服秒级轮换边界切换", async () => {
  const previous = row("30", "2026-10-01 04:00:00", "2026-11-01 03:59:59");
  const current = row("31", "2026-11-01 04:00:00", "2026-12-01 03:59:59");
  const exportOnly = { id: "32", list: { begin: "2026-12-01 04:00:00", end: "2027-01-01 03:59:59" } };
  const records = [current, exportOnly, previous];
  const select = async (time: string) =>
    (await findPreviousChallenge(theaterMode, records, async (entry) => readChallengeFacts(theaterMode, entry), Date.parse(time)))?.entry.id;
  expect(await select("2026-11-01T03:59:59.999+08:00")).toBeUndefined();
  expect(await select("2026-11-01T04:00:00+08:00")).toBe("30");
  expect(await select("2026-12-01T03:59:59.999+08:00")).toBe("30");
  expect(await select("2026-12-01T04:00:00+08:00")).toBeUndefined();
});

test("幻想剧诗下期需要公告对应的实装窗口，按最后一秒切换", async () => {
  const current = { ...row("31", "2026-11-01 04:00:00", "2026-12-01 03:59:59"), name: "31" };
  const next = { ...row("32", "2026-12-01 04:00:00", "2027-01-01 03:59:59"), name: "32" };
  const records = [current, next];
  const select = async (entries: readonly { id: string; name: string; list: object }[] = records, time = "2026-12-01T03:59:59.999+08:00") =>
    (await findAnnouncedChallengeNext(theaterMode, entries, async (entry) => readChallengeFacts(theaterMode, entry), Date.parse(time)))?.entry.id;
  expect(await select()).toBe("32");
  expect(await select(records, "2026-12-01T04:00:00+08:00")).toBeUndefined();
  expect(await select([current, { ...next, list: { begin: next.list.live_begin, end: next.list.live_end } }])).toBeUndefined();
  expect(await select([current, { ...next, id: "33", name: "33" }])).toBeUndefined();
});

test("深境上期只使用首尾相邻且与公告无冲突的实装窗口", async () => {
  const earlier = row("123", "2026-09-16 04:00:00", "2026-10-16 03:59:59");
  const previous = row("124", "2026-10-16 04:00:00", "2026-11-16 03:59:59");
  const current = row("125", "2026-11-16 04:00:00", "2026-12-16 03:59:59");
  const conflict = row("126", "2027-01-16 04:00:00", "2027-02-16 03:59:59");
  const choosePrevious = async (records: readonly { id: string; list: object }[], time: string) =>
    (await findPreviousChallenge(abyssMode, records, async (entry) => readChallengeFacts(abyssMode, entry), Date.parse(time)))?.entry.id;
  const records = [current, previous, earlier, conflict];
  expect(await choosePrevious(records, "2026-11-16T03:59:59.999+08:00")).toBe("123");
  expect(await choosePrevious(records, "2026-11-16T04:00:00+08:00")).toBe("124");
  expect(await choosePrevious([earlier, previous, { id: "125", list: { begin: current.list.live_begin, end: current.list.live_end } }],
    "2026-11-16T04:00:00+08:00")).toBeUndefined();
  expect(await choosePrevious([...records, row("补窗夹具", "2026-12-16 04:00:00", "2027-01-16 03:59:59")],
    "2027-01-16T04:00:00+08:00")).toBeUndefined();
  expect(await choosePrevious([...records, row("后继夹具", "2027-02-16 04:00:00", "2027-03-16 03:59:59")],
    "2027-02-16T04:00:00+08:00")).toBeUndefined();
});

test("危局上期在短轮换结束后保持待核对，忽略后继导出窗", async () => {
  const earlier = row("690481", "2026-10-23 04:00:00", "2026-11-06 03:59:59");
  const previous = row("690491", "2026-11-06 04:00:00", "2026-11-20 03:59:59");
  const current = row("690501", "2026-11-20 04:00:00", "2026-12-02 03:59:59");
  const exportOnly = { id: "690511", list: { begin: "2026-12-02 04:00:00", end: "2026-12-16 03:59:59" } };
  const records = [current, earlier, previous, exportOnly];
  const select = async (time: string) =>
    (await findPreviousChallenge(deadlyAssaultMode, records, async (entry) => readChallengeFacts(deadlyAssaultMode, entry), Date.parse(time)))?.entry.id;
  expect(await select("2026-11-20T03:59:59.999+08:00")).toBe("690481");
  expect(await select("2026-11-20T04:00:00+08:00")).toBe("690491");
  expect(await select("2026-12-02T03:59:59.999+08:00")).toBe("690491");
  expect(await select("2026-12-02T04:00:00+08:00")).toBeUndefined();
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

test("原神最新实装窗包含最后一秒，存在导出和公告冲突时不推期次", async () => {
  const tower = findChallengeMode("gi", "深渊")!;
  const theater = findChallengeMode("gi", "幻想真境")!;
  const now = "2026-11-19T12:00:00+08:00";
  const towerRows = [row("125", "2026-11-16 04:00:00", "2026-12-16 03:59:59"),
    row("126", "2027-01-16 04:00:00", "2027-02-16 03:59:59"), row("20099"), row("20100")];
  const theaterRows = [row("31", "2026-11-01 04:00:00", "2026-12-01 03:59:59"),
    row("32", "2026-12-01 04:00:00", "2027-01-01 03:59:59"), row("33")];
  expect(await choose(tower, towerRows, now)).toBe("125");
  expect(await choose(theater, theaterRows, now)).toBe("31");
  expect(await choose(tower, towerRows, "2026-12-16T03:59:59.999+08:00")).toBe("125");
  expect(await choose(tower, towerRows, "2026-12-16T04:00:00+08:00")).toBeUndefined();
  expect(await choose(tower, towerRows, "2027-01-19T12:00:00+08:00")).toBeUndefined();
  expect(await choose(theater, theaterRows, "2026-11-30T20:00:00Z")).toBe("32");
  expect(await choose(theater, [row("未知精度", "2026-11-01 04:00:00", "2026-12-01 04:00:00")], now)).toBeUndefined();
});

test("式舆只采用常规剧变节点，危局按已公布的不同长度窗口轮换", async () => {
  const shiyu = findChallengeMode("zzz", "式舆防卫战")!;
  const assault = findChallengeMode("zzz", "危局强袭战")!;
  const normal = { sort: 1, zh: "剧变节点" };
  const now = "2026-11-19T12:00:00+08:00";
  const oldShiyu = row("62037", "2025-12-19 04:00:00", "2025-12-29 14:59:59", normal);
  const activeShiyu = row("62061", "2026-11-13 04:00:00", "2026-11-27 03:59:59", normal);
  const nextShiyu = row("62062", "2026-11-27 04:00:00", "2026-12-11 03:59:59", normal);
  const otherNode = row("61003", activeShiyu.list.live_begin, activeShiyu.list.live_end, { sort: 4, zh: "奇袭节点" });
  const wrongSubtype = row("61004", activeShiyu.list.live_begin, activeShiyu.list.live_end, { sort: 1, zh: "奇袭节点" });
  const pending = row("620631", undefined, undefined, normal);
  expect(await choose(shiyu, [activeShiyu, nextShiyu, otherNode, wrongSubtype, pending], now)).toBe("62061");
  expect(await choose(shiyu, [nextShiyu, otherNode, wrongSubtype, pending], now)).toBeUndefined();
  expect(await choose(shiyu, [activeShiyu, { ...activeShiyu, id: "other" }], now)).toBeUndefined();
  expect(await choose(shiyu, [oldShiyu], "2025-12-29T14:59:59.500+08:00")).toBe("62037");
  expect(await choose(shiyu, [oldShiyu], "2025-12-29T15:00:00+08:00")).toBeUndefined();
  const assaultRows = [row("690491", "2026-11-06 04:00:00", "2026-11-20 03:59:59"),
    row("690501", "2026-11-20 04:00:00", "2026-12-02 03:59:59"), row("690511")];
  expect(await choose(assault, assaultRows, now)).toBe("690491");
  expect(await choose(assault, assaultRows, "2026-11-20T04:00:00+08:00")).toBe("690501");
  expect(await choose(assault, assaultRows, "2026-12-02T04:00:00+08:00")).toBeUndefined();
});

test("幽境本期和上期仅使用连续的实装窗口，导出中的预览不抢当期", async () => {
  const rows = [
    { id: "5269012", list: { live_begin: "2026-09-30 10:00:00", live_end: "2026-11-11 09:59:59" } },
    { id: "5269013", list: { live_begin: "2026-11-11 10:00:00", live_end: "2026-12-23 09:59:59" } },
    { id: "5269014", list: { begin: "2026-11-03 10:00:00", end: "2026-12-01 03:59:59" } },
  ];
  const read = async (row: typeof rows[number]) => readChallengeFacts(onslaughtMode, row);
  const before = Date.parse("2026-11-11T09:59:59+08:00");
  const boundary = before + 1000;
  expect((await findCurrentChallenge(onslaughtMode, rows, read, before))?.entry.id).toBe("5269012");
  expect((await findCurrentChallenge(onslaughtMode, rows, read, boundary))?.entry.id).toBe("5269013");
  expect((await findPreviousChallenge(onslaughtMode, rows, read, boundary))?.entry.id).toBe("5269012");
  expect(await findPreviousChallenge(onslaughtMode, rows.slice(1), read, boundary)).toBeUndefined();
  expect(await findCurrentChallenge(onslaughtMode, rows, read, Date.parse("2026-12-23T10:00:00+08:00"))).toBeUndefined();
});
