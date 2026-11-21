import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planAtlasChallengeRefresh } from "./challenge-refresh-plan.ts";
import { createAtlasMaintenance } from "./maintenance.ts";
import { legacyAtlasSourcePages } from "./legacy-source-profile.ts";
import { atlasRotationPages, parseAtlasUpdatePolicy } from "./update-policy.ts";
import { validateAtlasCandidate } from "./validate-candidate.ts";

const listings = {
  gi: { live: "7.2", latest: "7.2.52", available: ["7.2", "7.2.52"] },
  hsr: { live: "4.7", latest: "4.7.52", available: ["4.7", "4.7.52"] },
  zzz: { live: "3.3", latest: "3.4.5+20699967", available: ["3.3", "3.4.5+20699967"] },
} as const;
const supported = parseAtlasUpdatePolicy({}).challenge.selections;

async function fixture(channel: "latest" | "live") {
  const workspace = await mkdtemp(join(tmpdir(), "lotus-atlas-rotation-"));
  const root = join(workspace, "atlas");
  const data = join(root, "snapshots", "1", "data");
  await mkdir(join(data, "items"), { recursive: true });
  await symlink("snapshots/1/data", join(root, "current"));
  const byPath = new Map<string, unknown>();
  const scope = legacyAtlasSourcePages.filter(({ game, pageId }) => supported.includes(`${game}/${pageId}`));
  const games = Object.fromEntries((["gi", "hsr", "zzz"] as const).map((game) =>
    [game, { locales: { zh: { pages: {} as Record<string, unknown> } } }]));
  for (const { game, pageId, indexShape, indexPath, version: previous } of legacyAtlasSourcePages) {
    const version = listings[game][channel];
    const id = indexShape === "array" ? "0" : "1";
    const path = `items/${game}-${pageId.replaceAll("/", "-")}.json`;
    const name = `${game} ${pageId}`;
    const row = { zh: name, begin: "2026-11-01", end: "2026-12-01" };
    const record = { id, name, path, hasDetail: false };
    games[game]!.locales.zh.pages[pageId] = {
      id: pageId, version, sampled: false, recordCount: 1, totalRecordCount: 1, records: { [id]: record },
    };
    await writeFile(join(data, path), JSON.stringify({
      meta: { gameId: game, pageId, version, locale: "zh", recordId: id, name, hasDetail: false },
      content: { list: row, detail: null },
    }));
    byPath.set(indexPath.replace(`/${previous}/`, `/${version}/`), indexShape === "array" ? [row] : { [id]: row });
  }
  const gcgEntry = { id: "1101", name: "甘雨", path: "items/gi-gcg.json", hasDetail: false };
  const gcgVersion = listings.gi[channel];
  games.gi!.locales.zh.pages.gcg = { id: "gcg", version: gcgVersion, sampled: false,
    recordCount: 1, totalRecordCount: 1, records: { [gcgEntry.id]: gcgEntry } };
  await writeFile(join(data, gcgEntry.path), JSON.stringify({
    meta: { gameId: "gi", pageId: "gcg", version: gcgVersion, locale: "zh", recordId: gcgEntry.id, name: gcgEntry.name, hasDetail: false },
    content: { list: { zh: gcgEntry.name }, detail: null },
  }));
  await writeFile(join(data, "map.json"), JSON.stringify({ games }));
  const current = await validateAtlasCandidate(data);
  const versions = Object.fromEntries(Object.entries(listings).map(([game, row]) => [game, row[channel]]));
  const calls: string[] = [];
  function request(url: string, options: RequestInit) {
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://static.nanoka.cc");
    expect(options.credentials).toBe("omit");
    calls.push(parsed.pathname);
    const body = byPath.get(parsed.pathname);
    return Promise.resolve(body === undefined ? new Response(null, { status: 404 }) : Response.json(body));
  }
  return { workspace, root, data, byPath, current, scope, versions, request, calls };
}

test.each(["latest", "live"] as const)("同版挑战在 %s 只核对轮换索引，重复运行不发布", async (version_channel) => {
  const run = await fixture(version_channel);
  try {
    const maintenance = createAtlasMaintenance(run.root, { updateConfig: { version_channel }, manifest: async () => listings, request: run.request });
    expect(maintenance.atlasSchedule.challenge.cron).toBe("0 15 */2 * * *");
    const checked = await maintenance.atlasSchedule.version.run();
    expect(checked).toContain(`七圣召唤 · 已是同一版本 ${listings.gi[version_channel]}`);
    expect(checked).toContain("本地所选 29 类版本均为目标版本");
    expect(run.calls).toHaveLength(0);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await maintenance.atlasSchedule.challenge.run()).toContain("来源索引与现用资料一致");
    }
    expect(run.calls).toHaveLength(atlasRotationPages.size * 2);
    expect(new Set(run.calls).size).toBe(atlasRotationPages.size);
    expect(await readlink(join(run.root, "current"))).toBe("snapshots/1/data");
    expect(await readdir(run.workspace)).toEqual(["atlas"]);
  } finally {
    await rm(run.workspace, { recursive: true, force: true });
  }
});

test("同版新轮换只核对受影响游戏依赖，并返回实际变化的索引", async () => {
  const run = await fixture("latest");
  try {
    const tower = "/gi/7.2.52/tower.json";
    const monster = "/gi/7.2.52/monster.json";
    run.byPath.set(tower, { ...run.byPath.get(tower) as object, "2": { zh: "新一期", begin: "2026-12-01", end: "2027-01-01" } });
    run.byPath.set(monster, { ...run.byPath.get(monster) as object, "2": { zh: "新敌人" } });
    const result = await planAtlasChallengeRefresh(run.data, run.current.pages, run.scope, run.versions, undefined, run.request);
    expect(result.map(({ game, pageId }) => `${game}/${pageId}`)).toEqual(["gi/tower", "gi/monster"]);
    expect(run.calls.filter(url => url.endsWith("/monster.json"))).toEqual([monster]);
    expect(run.calls).toHaveLength(10);
  } finally {
    await rm(run.workspace, { recursive: true, force: true });
  }
});

test("同版轮换缺页或移除已收录条目时保留现用快照", async () => {
  const run = await fixture("latest");
  try {
    const tower = "/gi/7.2.52/tower.json";
    const maintenance = createAtlasMaintenance(run.root, { updateConfig: { version_channel: "latest" }, manifest: async () => listings, request: run.request });
    run.byPath.delete(tower);
    expect(await maintenance.atlasSchedule.challenge.run()).toContain("现用快照仍可用");
    run.byPath.set(tower, { "2": { zh: "只有新一期" } });
    expect(await maintenance.atlasSchedule.challenge.run()).toContain("现用快照仍可用");
    expect(await readlink(join(run.root, "current"))).toBe("snapshots/1/data");
    expect(await readdir(run.workspace)).toEqual(["atlas"]);
  } finally {
    await rm(run.workspace, { recursive: true, force: true });
  }
});
