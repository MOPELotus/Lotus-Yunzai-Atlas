import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtlasRuntimeCatalog } from "./catalog.ts";
import { deadlyAssaultMode, findCurrentChallenge } from "./challenges.ts";
import { readAtlasSnapshotVersion } from "./publish-candidate.ts";
import { refreshAtlasSource } from "./refresh-source.ts";
import { acquireAtlasSource } from "./source-acquisition.ts";

const oldVersion = "3.2";
const publishedVersion = "3.3";
const development = "3.4.4+20539349";
const manifest = async () => ({ zzz: { latest: development, live: publishedVersion, available: [publishedVersion, development] } });
const webp = new Uint8Array(Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64"));
const absent = () => new Response(null, { status: 404 });
const time = (id: number, begin: string, end: string) => ({ id, begin, end });

const earlier = time(690491, "2026-11-06 04:00:00", "2026-11-20 03:59:59");
const later = time(690501, "2026-11-20 04:00:00", "2026-12-02 03:59:59");
type Round = typeof earlier;
type Fault = "detail" | "enemy-art" | "role-icon" | "omit-role-icon";

function source(version: string, rounds: readonly Round[], fault?: Fault, requests: string[] = []) {
  return async (url: string) => {
    requests.push(url);
    const base = `https://static.nanoka.cc/zzz/${version}`;
    if (url === `${base}/boss.json`) return Response.json(Object.fromEntries(rounds.map(({ id, begin, end }) => [
      id, { sort: 9, zh: "试炼", zone_type: 1001, begin, end, live_begin: begin, live_end: end },
    ])));
    const round = rounds.find(({ id }) => url === `${base}/zh/boss/${id}.json`);
    if (round) {
      const zones = Object.fromEntries([1, 2, 3].map((stage) => {
        const zone = round.id * 100 + stage;
        const options = Object.fromEntries([1, 2, 3].map((option) => [option, { title: `增益 ${option}`, desc: "提升10%。" }]));
        return [zone, {
          name: `敌人 ${stage}`, stage_num: stage, monster_level: 70, goal_type: 2,
          s_rank_goal: 20000, a_rank_goal: 14000, b_rank_goal: 6000,
          layer_buff: { "1": { title: "", desc: fault === "omit-role-icon" ? "适合异常。" : "适合<IconMap:Icon_AvatarClass_Anomaly>[异常]。" } },
          layer_room: { [zone * 10 + 1]: {
            monster_icon: "Assets/NapResources/UI/Sprite/A1DynamicLoad/IconBossGeneral/UnPacker/IconMonster_Fixture.png",
            monster_weakness: { "201": "火属性" }, monster_resistance: {},
            monster_list: { "12": { id: 40012, name: `敌人 ${stage}`, stats: { hp: 12000 },
              image: "UI/Sprite/A1DynamicLoad/BossCard/UnPacker/BossCardLv04/Monster_Fixture.png" } },
          } },
          selectable_buff: options,
        }];
      }));
      return Response.json({ id: round.id, name: "试炼", zone_type: 1001,
        begin_time: round.begin, end_time: fault === "detail" ? "" : round.end, modes: [{ zone_type: 1001, zone: zones }] });
    }
    const asset = "https://static.nanoka.cc/assets/zzz/";
    if (url === asset + "IconMonster_Fixture.webp") return absent();
    if (url === asset + "Monster_Fixture.webp") return fault === "enemy-art" ? absent() : new Response(webp);
    if (url === asset + "IconAnomaly.webp") return fault === "role-icon" ? absent() : new Response(webp);
    throw new Error(`意外的来源请求：${url}`);
  };
}

async function fixture(run: (root: string, work: string) => Promise<void>, version = oldVersion) {
  const work = await mkdtemp(join(tmpdir(), "lotus-boss-refresh-"));
  const root = join(work, "atlas");
  try {
    await acquireAtlasSource(root, [{ game: "zzz", pageId: "boss", version }], undefined, source(version, [earlier]));
    await run(root, work);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

test("危局只获取正式版，合成后按实装窗读到完整新旧轮换与原图", () => fixture(async (root, work) => {
  const requests: string[] = [];
  const result = await refreshAtlasSource(root, { selection: "zzz/boss", manifest, request: source(publishedVersion, [earlier, later], undefined, requests) });
  expect(result).toEqual({ status: "published", version: 1, directory: join(root, "snapshots/1/data") });
  expect(requests.filter((url) => url.endsWith("/boss.json"))).toEqual(["https://static.nanoka.cc/zzz/3.3/boss.json"]);
  expect(requests.filter((url) => url.endsWith("/Monster_Fixture.webp"))).toHaveLength(1);
  const catalog = createAtlasRuntimeCatalog(root);
  const snapshot = await catalog.read();
  const entries = snapshot.pages.find(({ challengeMode }) => challengeMode?.id === "boss")?.entries ?? [];
  const current = await findCurrentChallenge(deadlyAssaultMode, entries, (item) => catalog.challengeFacts(item, deadlyAssaultMode),
    Date.parse("2026-11-20T04:00:00+08:00"));
  expect(entries.map(({ id }) => id)).toEqual(["690491", "690501"]);
  expect(current?.entry.id).toBe("690501");
  const detail = await catalog.deadlyAssaultDetails(current!.entry, snapshot);
  expect(detail?.divisions[0]?.encounters[0]?.rooms[0]?.enemies[0]?.artwork).toBe("gallery/zzz/Monster_Fixture.webp");
  expect(await readdir(work)).toEqual(["atlas"]);
}));

test("同正式版本不请求详情，旧快照版本更高时也保留现状", async () => {
  const requests: string[] = [];
  await fixture(async (root) => {
    expect(await refreshAtlasSource(root, { selection: "zzz/boss", manifest, request: source(publishedVersion, [earlier], undefined, requests) }))
      .toEqual({ status: "current", version: publishedVersion });
  }, publishedVersion);
  await fixture(async (root) => {
    expect(await refreshAtlasSource(root, { selection: "zzz/boss", manifest, request: source(publishedVersion, [earlier], undefined, requests) }))
      .toEqual({ status: "review", reason: "unproven-upgrade" });
  }, "3.4");
  expect(requests).toEqual([]);
});

test("危局来源实装窗重叠、详情时间错误或必需原图缺失时保留旧指针", () => fixture(async (root, work) => {
  const overlap = { ...later, begin: "2026-11-19 04:00:00" };
  await expect(refreshAtlasSource(root, { selection: "zzz/boss", manifest, request: source(publishedVersion, [earlier, overlap]) }))
    .rejects.toThrow("实装窗口重叠");
  await expect(refreshAtlasSource(root, { selection: "zzz/boss", manifest, request: source(publishedVersion, [earlier, later], "detail") }))
    .rejects.toThrow("实装窗口不符");
  await expect(refreshAtlasSource(root, { selection: "zzz/boss", manifest, request: source(publishedVersion, [earlier, later], "enemy-art") }))
    .rejects.toThrow("危局来源原图缺失");
  await expect(refreshAtlasSource(root, { selection: "zzz/boss", manifest, request: source(publishedVersion, [earlier, later], "role-icon") }))
    .rejects.toThrow("危局来源原图缺失");
  expect(await readAtlasSnapshotVersion(root)).toBeNull();
  expect(await readdir(work)).toEqual(["atlas"]);
}));

test("危局不发布丢失旧轮换、改变旧实装时间或少了已下载图标的候选", () => fixture(async (root, work) => {
  const valid = async (rounds: readonly Round[], fault?: Fault) => refreshAtlasSource(root, {
    selection: "zzz/boss", manifest, request: source(publishedVersion, rounds, fault),
  });
  expect(await valid([later])).toMatchObject({ status: "invalid", issues: ["危局强袭战 690491 缺少已有轮换资料。"] });
  expect(await valid([{ ...earlier, begin: "2026-11-07 04:00:00" }, later])).toMatchObject({
    status: "invalid", issues: ["危局强袭战 690491 与已有身份或实装窗口冲突。"],
  });
  const missingIcon = await valid([earlier, later], "omit-role-icon");
  expect(missingIcon.status).toBe("invalid");
  if (missingIcon.status === "invalid") expect(missingIcon.issues[0]).toContain("缺少已下载图标");
  expect(await readAtlasSnapshotVersion(root)).toBeNull();
  expect(await readdir(work)).toEqual(["atlas"]);
}));
