import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtlasRuntimeCatalog } from "./catalog.ts";
import { findCurrentChallenge, findNextShiyu, shiyuMode } from "./challenges.ts";
import { readAtlasSnapshotVersion } from "./publish-candidate.ts";
import { refreshAtlasSource } from "./refresh-source.ts";
import { acquireAtlasSource } from "./source-acquisition.ts";

const live = "3.3";
const preview = "3.4.4+20539349";
const manifest = async () => ({ zzz: { live, latest: preview, available: [live, preview] } });
const webp = new Uint8Array(Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64"));
const first = { id: 62061, begin: "2026-11-13 04:00:00", end: "2026-11-27 03:59:59" };
const second = { id: 62062, begin: "2026-11-27 04:00:00", end: "2026-12-11 03:59:59" };
type Round = typeof first;
type Fault = "child" | "preview" | "asset" | "omitted-art";
const monsterPath = "UI/Sprite/A1DynamicLoad/BossCard/UnPacker/BossCardLv03/Monster_Fixture.png";
const iconPath = "Assets/NapResources/UI/Sprite/A1DynamicLoad/IconBossGeneral/UnPacker/IconMonster_Fixture.png";

function source(version: string, rows: readonly Round[], calls: string[] = [], fault?: Fault) {
  const base = `https://static.nanoka.cc/zzz/${version}`;
  return async (url: string) => {
    calls.push(url);
    if (url === `${base}/shiyu.json`) return Response.json(Object.fromEntries([
      ["61001", { zh: "稳定节点", sort: 2 }],
      ...rows.map(({ id, begin, end }) => [id, { zh: "剧变节点", sort: 1, begin, end,
        ...(fault === "preview" ? {} : { live_begin: begin, live_end: end }) }]),
    ]));
    const round = rows.find(({ id }) => url === `${base}/zh/shiyu/${id}.json`);
    const permanent = url === `${base}/zh/shiyu/61001.json`;
    if (round || permanent) {
      const id = round?.id ?? 61001;
      const zones = Object.fromEntries(Array.from({ length: permanent ? 10 : 8 }, (_, offset) => {
        const stage = offset + 1;
        const zone = id * 100 + stage;
        const combined = !permanent && stage === 5;
        const nested = !permanent && stage > 5;
        const key = nested ? id * 1000 + 51 + offset - 5 : zone;
        const room = {
          monster_weakness: {}, monster_resistance: {},
          monster_icon: fault === "omitted-art" ? "" : iconPath,
          monster_list: { "101": { id: 101, name: "测试敌人", image: monsterPath, stats: { hp: 2500 } } },
        };
        return [key, {
          name: combined ? "" : `防线 ${stage}`, stage_num: nested ? 5 : stage, goal_type: combined ? 3 : nested ? 2 : 0,
          monster_level: combined ? 0 : 70, child: combined ? [id * 1000 + 51, id * 1000 + 52, id * 1000 + (fault === "child" ? 54 : 53)] : [],
          s_rank_goal: combined || nested ? 20000 : 300, a_rank_goal: combined || nested ? 16000 : 420,
          b_rank_goal: combined || nested ? 8000 : 600, layer_buff: { "1": { title: "测试增益", desc: "效果。" } },
          layer_room: combined ? {} : { [key * 10 + 1]: room },
        }];
      }));
      return Response.json({ id, priority: permanent ? 2 : 1, name: permanent ? "稳定节点" : "剧变节点", zone: zones,
        ...(round ? { begin_time: round.begin, end_time: round.end } : {}) });
    }
    if (url === "https://static.nanoka.cc/assets/zzz/IconMonster_Fixture.webp") return new Response(null, { status: 404 });
    if (url === "https://static.nanoka.cc/assets/zzz/Monster_Fixture.webp") {
      return fault === "asset" ? new Response(null, { status: 404 }) : new Response(webp);
    }
    throw new Error(`意外的来源请求：${url}`);
  };
}

async function fixture(run: (root: string, directory: string) => Promise<void>, version = "3.2") {
  const directory = await mkdtemp(join(tmpdir(), "lotus-shiyu-refresh-"));
  const root = join(directory, "atlas");
  try {
    await acquireAtlasSource(root, [{ game: "zzz", pageId: "shiyu", version }], undefined, source(version, [first]));
    await run(root, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("式舆刷新正式版本，稳定节点仍独立，剧变可读本期、下期和第五防线原图", () => fixture(async (root) => {
  const calls: string[] = [];
  const result = await refreshAtlasSource(root, { selection: "zzz/shiyu", manifest, request: source(live, [first, second], calls) });
  expect(result).toEqual({ status: "published", version: 1, directory: join(root, "snapshots/1/data") });
  expect(calls.filter((url) => url.endsWith("/shiyu.json"))).toEqual(["https://static.nanoka.cc/zzz/3.3/shiyu.json"]);
  expect(calls.filter((url) => url.endsWith("/Monster_Fixture.webp"))).toHaveLength(1);
  const catalog = createAtlasRuntimeCatalog(root);
  const snapshot = await catalog.read();
  const records = snapshot.pages.find(({ challengeMode }) => challengeMode?.id === "shiyu")?.entries ?? [];
  expect(records.map(({ name }) => name)).toEqual(["稳定节点", "剧变节点", "剧变节点"]);
  const facts = (entry: (typeof records)[number]) => catalog.challengeFacts(entry, shiyuMode);
  const now = Date.parse("2026-11-19T18:00:00+08:00");
  expect((await findCurrentChallenge(shiyuMode, records, facts, now))?.entry.id).toBe("62061");
  const next = await findNextShiyu(records, facts, now);
  expect(next?.entry.id).toBe("62062");
  const nextCard = await catalog.shiyuDetails(next!.entry, snapshot, "next");
  expect(nextCard?.forecast).toBe(true);
  expect(nextCard?.defenses[4]?.challenges.map((room) => room.rooms[0]?.enemies[0]?.artwork))
    .toEqual(Array(3).fill("gallery/zzz/Monster_Fixture.webp"));
  expect(await refreshAtlasSource(root, { selection: "zzz/shiyu", manifest,
    request: async () => { throw new Error("同版本不应抓取详情"); } })).toEqual({ status: "current", version: live });
}));

test("式舆拒绝回落到低于已有数据的正式版本", () => fixture(async (root) => {
  const calls: string[] = [];
  expect(await refreshAtlasSource(root, { selection: "zzz/shiyu", manifest, request: source(live, [first], calls) }))
    .toEqual({ status: "review", reason: "unproven-upgrade" });
  expect(calls).toEqual([]);
}, "3.4"));

test("式舆窗口重叠、预览、子房间损坏或原图缺失时保留已有快照", () => fixture(async (root, directory) => {
  const refresh = (rows: readonly Round[], fault?: Fault) => refreshAtlasSource(root, {
    selection: "zzz/shiyu", manifest, request: source(live, rows, [], fault),
  });
  await expect(refresh([first, { ...second, begin: "2026-11-26 04:00:00" }])).rejects.toThrow("实装窗口重叠");
  await expect(refresh([first], "preview")).rejects.toThrow("实装窗口或节点身份");
  await expect(refresh([first], "child")).rejects.toThrow("来源详情缺少防线");
  await expect(refresh([first], "asset")).rejects.toThrow("式舆来源原图缺失");
  expect(await refresh([second])).toMatchObject({ status: "invalid", issues: ["式舆防卫战 62061 缺少已有轮换资料。"] });
  const omitted = await refresh([first], "omitted-art");
  expect(omitted.status).toBe("invalid");
  if (omitted.status === "invalid") expect(omitted.issues[0]).toContain("缺少已下载图标");
  expect(await readAtlasSnapshotVersion(root)).toBeNull();
  expect(await readdir(directory)).toEqual(["atlas"]);
}));
