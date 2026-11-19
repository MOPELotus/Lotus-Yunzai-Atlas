import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAtlasCandidate } from "./apply-candidate.ts";
import { createAtlasRuntimeCatalog, findBangboos, findEquipment } from "./catalog.ts";
import { publishAtlasCandidate, readAtlasSnapshotVersion } from "./publish-candidate.ts";
import { refreshAtlasSource } from "./refresh-source.ts";
import { acquireAtlasSource } from "./source-acquisition.ts";

const original = "3.4.4+20539349";
const upgrade = "3.4.4+20539350";
const scope = (version: string) => [{ game: "zzz", pageId: "bangboo", version, recordCount: 1 }] as const;
const icon = "UI/Sprite/A1DynamicLoad/BangbooModGarage/UnPacker/BangbooRole/Fixture.png";
const webp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
const missing = () => new Response(null, { status: 404 });
const manifest = (version: string) => async () => ({ zzz: { latest: version, available: [version] } });

function source(version: string, available: "all" | "detail-missing" | "icon-missing" = "all") {
  const name = `样例邦布 ${version}`;
  return async (url: string) => {
    if (url === `https://static.nanoka.cc/zzz/${version}/bangboo.json`) return Response.json({ "53001": { zh: name, rank: 3, icon } });
    if (url === `https://static.nanoka.cc/zzz/${version}/zh/bangboo/53001.json`) {
      return available === "detail-missing" ? missing() : Response.json({ id: 53001, name, rarity: 3, icon });
    }
    if (url.startsWith("https://static.nanoka.cc/assets/zzz/") && url.endsWith("Fixture.webp")) {
      return available === "icon-missing" ? missing() : new Response(new Uint8Array(webp));
    }
    throw new Error(`意外的来源夹具请求 ${url}`);
  };
}

async function fixture(run: (workspace: string, root: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "lotus-atlas-refresh-fixture-"));
  const root = join(workspace, "atlas");
  try {
    await acquireAtlasSource(root, scope(original), undefined, source(original));
    await run(workspace, root);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("邦布自动刷新按计划抓取较新构建并发布完整候选", () => fixture(async (workspace, root) => {
  const catalog = createAtlasRuntimeCatalog(root);
  const [old] = findBangboos(await catalog.read(), "53001");
  const result = await refreshAtlasSource(root, { manifest: manifest(upgrade), request: source(upgrade) });
  expect(result).toEqual({ status: "published", version: 1, directory: join(root, "snapshots/1/data") });
  const [updated] = findBangboos(await catalog.read(), "53001");
  expect(updated?.version).toBe(upgrade);
  expect(catalog.assetRoot(updated!)).toBe(join(root, "snapshots/1/data"));
  expect(catalog.assetRoot(old!)).toBe(join(root, "data"));
  expect(await readdir(workspace)).toEqual(["atlas"]);
}));

function engineSource(version: string) {
  const name = `样例音擎 ${version}`;
  const asset = "Weapon_A_Refresh";
  return async (url: string) => {
    if (url.endsWith(`/${version}/weapon.json`)) {
      return Response.json({ "13001": { zh: name, icon: asset, rank: 3, type: 4 } });
    }
    if (url.endsWith(`/${version}/zh/weapon/13001.json`)) return Response.json({
      id: 13001, name, code_name: asset, rarity: 3, weapon_type: { 4: { name: "样例专精" } },
      icon: `Assets/NapResources/UI/Sprite/A1DynamicLoad/ItemIconWeapon/UnPacker/${asset}.png`,
    });
    if (url.endsWith(`/assets/zzz/${asset}.webp`)) return new Response(new Uint8Array(webp));
    throw new Error("刷新请求超出了音擎分类。");
  };
}

async function seedEngines(workspace: string, root: string) {
  const donor = join(workspace, "weapon");
  const selected = [{ game: "zzz", pageId: "weapon", version: original }] as const;
  await acquireAtlasSource(donor, selected, undefined, engineSource(original));
  expect((await applyAtlasCandidate(root, donor, selected)).status).toBe("published");
  await rm(donor, { recursive: true });
}

test("音擎刷新只请求和发布选中的分类并保留邦布", () => fixture(async (workspace, root) => {
  await seedEngines(workspace, root);
  const result = await refreshAtlasSource(root, { pageId: "weapon", manifest: manifest(upgrade), request: engineSource(upgrade) });
  expect(result).toMatchObject({ status: "published", version: 2 });
  const index = await createAtlasRuntimeCatalog(root).read();
  expect(findEquipment(index, "13001", "zzz")[0]?.version).toBe(upgrade);
  expect(findBangboos(index, "53001")[0]?.version).toBe(original);
}));

const genshinOriginal = "7.2.52";
const genshinUpgrade = "7.2.53";
const genshinScope = [{ game: "gi", pageId: "weapon", version: genshinOriginal }] as const;
const genshinIndex = (version: string) => `https://static.nanoka.cc/gi/${version}/weapon.json`;
const genshinDetail = (version: string, id: number) => `https://static.nanoka.cc/gi/${version}/zh/weapon/${id}.json`;
const genshinArt = "https://static.nanoka.cc/assets/gi/UI_EquipIcon_Refresh.webp";
const genshinEventArt = "https://static.nanoka.cc/assets/gi/Sword_Template.webp";
const genshinManifest = (version: string, zenless = original) => async () => ({
  gi: { latest: version, available: [genshinOriginal, genshinUpgrade] }, zzz: { latest: zenless, available: [original, upgrade] },
});

function genshinSource(version: string) {
  const name = `样例原神武器 ${version}`;
  const normal = { rank: 1, type: "WEAPON_SWORD_ONE_HAND", icon: "UI_EquipIcon_Refresh", zh: name, atk: 74 };
  const event = { rank: 4, type: "ITEM_TPS_WEAPON", icon: "Sword_Template", zh: "样例活动武器" };
  const phases = [1, 2, 3, 4];
  return async (url: string) => {
    if (url === genshinIndex(version)) return Response.json({ "11101": normal, "224008": event });
    if (url === genshinDetail(version, 11101)) return Response.json({ name, rarity: normal.rank,
      weapon_type: normal.type, icon: normal.icon, desc: "说明。",
      stats_modifier: { atk: { base: 1, levels: Object.fromEntries(Array.from({ length: 70 }, (_, index) => [index + 1, index + 1])) } },
      ascension: Object.fromEntries(phases.map((phase) => [phase, { fight_prop_base_attack: phase }])),
      materials: Object.fromEntries(phases.map((phase) => [phase, { fixture: phase }])), refinement: {},
    });
    if (url === genshinDetail(version, 224008)) return Response.json({ name: event.zh, rarity: event.rank,
      weapon_type: event.type, icon: event.icon, desc: "活动说明。",
    });
    if (url === genshinArt || url === genshinEventArt) return new Response(new Uint8Array(webp));
    throw new Error(`刷新请求超出原神武器分类 ${url}`);
  };
}

async function seedGenshinWeapons(workspace: string, root: string) {
  const donor = join(workspace, "genshin-weapon");
  await acquireAtlasSource(donor, genshinScope, undefined, genshinSource(genshinOriginal));
  expect((await applyAtlasCandidate(root, donor, genshinScope)).status).toBe("published");
  await rm(donor, { recursive: true });
}

test("原神武器刷新跳过同版，与绝区零同名分类分别规划和发布", () => fixture(async (workspace, root) => {
  await seedGenshinWeapons(workspace, root);
  await seedEngines(workspace, root);
  const calls: string[] = [];
  const collect = genshinSource(genshinUpgrade);
  const request = async (url: string) => { calls.push(url); return collect(url); };
  expect(await refreshAtlasSource(root, { selection: "gi/weapon", manifest: genshinManifest(genshinOriginal, upgrade), request }))
    .toEqual({ status: "current", version: genshinOriginal });
  expect(await refreshAtlasSource(root, { pageId: "weapon", manifest: genshinManifest(genshinUpgrade), request }))
    .toEqual({ status: "current", version: original });
  expect(calls).toEqual([]);
  const catalog = createAtlasRuntimeCatalog(root);
  const previous = await catalog.read();
  expect(await refreshAtlasSource(root, { selection: "gi/weapon", manifest: genshinManifest(genshinUpgrade, upgrade), request }))
    .toEqual({ status: "published", version: 3, directory: join(root, "snapshots/3/data") });
  expect(calls).toEqual([genshinIndex(genshinUpgrade), genshinDetail(genshinUpgrade, 11101), genshinArt,
    genshinDetail(genshinUpgrade, 224008), genshinEventArt]);
  const current = await catalog.read();
  expect(findEquipment(current, "11101", "gi")[0]?.version).toBe(genshinUpgrade);
  expect(findEquipment(current, "13001", "zzz")[0]).toEqual(findEquipment(previous, "13001", "zzz")[0]);
  expect(findBangboos(current, "53001")[0]).toEqual(findBangboos(previous, "53001")[0]);
  expect(await readdir(workspace)).toEqual(["atlas"]);
}));

test("原神武器刷新遇到原图缺失或已有活动图标降级时保留旧指针", () => fixture(async (workspace, root) => {
  await seedGenshinWeapons(workspace, root);
  const collect = genshinSource(genshinUpgrade);
  const refresh = (absent: string) => refreshAtlasSource(root, {
    selection: "gi/weapon", manifest: genshinManifest(genshinUpgrade),
    request: async (url) => url === absent ? missing() : collect(url),
  });
  await expect(refresh(genshinArt)).rejects.toThrow("原神武器来源图标缺失");
  expect(await readAtlasSnapshotVersion(root)).toBe(1);
  expect(await refresh(genshinEventArt)).toEqual({ status: "invalid", issues: [
    "原神武器 224008 缺少已下载图标 icon。", "原神武器 224008 缺少已下载图标 detail.icon。",
  ] });
  expect(await readAtlasSnapshotVersion(root)).toBe(1);
  expect(await readdir(join(root, "snapshots"))).toEqual(["1"]);
  expect(await readdir(workspace)).toEqual(["atlas"]);
}));

const coneOriginal = "4.7.52";
const coneUpgrade = "4.7.53";
const coneScope = [{ game: "hsr", pageId: "lightcone", version: coneOriginal }] as const;
const coneIndex = (version: string) => `https://static.nanoka.cc/hsr/${version}/lightcone.json`;
const coneDetail = (version: string) => `https://static.nanoka.cc/hsr/${version}/zh/lightcone/20000.json`;
const coneArt = "https://static.nanoka.cc/assets/hsr/lightconemediumicon/20000.webp";
const conePath = "https://static.nanoka.cc/assets/hsr/pathicon/rogue.webp";

function lightconeSource(version: string) {
  const name = `样例光锥 ${version}`;
  const rarity = "CombatPowerLightconeRarity3";
  return async (url: string) => {
    if (url === coneIndex(version)) return Response.json({ "20000": { zh: name, rank: rarity, baseType: "Rogue" } });
    if (url === coneDetail(version)) return Response.json({ name, rarity, base_type: "Rogue",
      stats: Array.from({ length: 7 }, (_, index) => ({ equipment_id: 20000, max_level: (index + 2) * 10,
        base_hp: 20, base_attack: 10, base_defence: 5, base_hp_add: 1, base_attack_add: 1, base_defence_add: 1 })),
      refinements: { name: "效果", desc: "护盾提高。", level: Object.fromEntries(
        [1, 2, 3, 4, 5].map((rank) => [rank, { param_list: [] }]),
      ) },
    });
    if (url === coneArt || url === conePath) return new Response(new Uint8Array(webp));
    throw new Error(`刷新请求超出光锥分类 ${url}`);
  };
}

const coneManifest = (version: string) => async () => ({
  hsr: { latest: version, available: [coneOriginal, coneUpgrade] }, zzz: { latest: upgrade, available: [upgrade] },
});

async function seedLightcones(workspace: string, root: string) {
  const donor = join(workspace, "lightcone");
  await acquireAtlasSource(donor, coneScope, undefined, lightconeSource(coneOriginal));
  expect((await applyAtlasCandidate(root, donor, coneScope)).status).toBe("published");
  await rm(donor, { recursive: true });
}

test("光锥刷新跳过同版本，只更新星铁光锥并保留其他游戏的数据", () => fixture(async (workspace, root) => {
  await seedLightcones(workspace, root);
  const requests: string[] = [];
  const collect = lightconeSource(coneUpgrade);
  const request = async (url: string) => {
    requests.push(url);
    return collect(url);
  };
  expect(await refreshAtlasSource(root, { pageId: "lightcone", manifest: coneManifest(coneOriginal), request }))
    .toEqual({ status: "current", version: coneOriginal });
  expect(requests).toEqual([]);
  const catalog = createAtlasRuntimeCatalog(root);
  const previous = await catalog.read();
  const [old] = findEquipment(previous, "20000", "hsr");
  expect(await refreshAtlasSource(root, { pageId: "lightcone", manifest: coneManifest(coneUpgrade), request }))
    .toEqual({ status: "published", version: 2, directory: join(root, "snapshots/2/data") });
  expect(requests).toEqual([coneIndex(coneUpgrade), coneDetail(coneUpgrade), coneArt, conePath]);
  const current = await catalog.read();
  const [entry] = findEquipment(current, "20000", "hsr");
  expect(entry?.version).toBe(coneUpgrade);
  expect(findBangboos(current, "53001")[0]).toEqual(findBangboos(previous, "53001")[0]);
  expect(catalog.assetRoot(old!)).toBe(join(root, "snapshots/1/data"));
  expect(catalog.assetRoot(entry!)).toBe(join(root, "snapshots/2/data"));
  const item = await Bun.file(join(catalog.assetRoot(entry!), entry!.path)).json();
  expect(item.meta.images.map(({ fieldPath, status }: { fieldPath: string; status: string }) => [fieldPath, status]))
    .toEqual([["derived.lightConeMediumIcon", "downloaded"], ["derived.path", "downloaded"],
      ["detail.derived.lightConeMediumIcon", "downloaded"]]);
  expect(await readdir(workspace)).toEqual(["atlas"]);
}));

test("光锥详情、原图或命途图缺失时保留旧发布指针", () => fixture(async (workspace, root) => {
  await seedLightcones(workspace, root);
  const collect = lightconeSource(coneUpgrade);
  for (const [missingUrl, issue] of [[coneDetail(coneUpgrade), "HTTP 404"], [coneArt, "原图缺失"], [conePath, "命途图标缺失"]] as const) {
    await expect(refreshAtlasSource(root, { pageId: "lightcone", manifest: coneManifest(coneUpgrade),
      request: async (url) => url === missingUrl ? missing() : collect(url),
    })).rejects.toThrow(issue);
    expect(await readAtlasSnapshotVersion(root)).toBe(1);
  }
  expect(await readdir(join(root, "snapshots"))).toEqual(["1"]);
  expect(await readdir(workspace)).toEqual(["atlas"]);
}));

test("刷新 CLI 接受四个已支持的游戏和分类组合", () => fixture(async (workspace) => {
  const script = join(import.meta.dir, "refresh-source.ts");
  const absent = join(workspace, "missing");
  for (const selection of ["hsr/lightcone", "zzz/bangboo", "zzz/weapon", "gi/weapon"]) {
    const command = Bun.spawnSync([process.execPath, script, absent, selection]);
    expect(command.exitCode).toBe(1);
    expect(JSON.parse(command.stdout.toString())).toEqual({ status: "review", reason: "local-unverified" });
  }
  const wrong = Bun.spawnSync([process.execPath, script, absent, "zzz/lightcone"]);
  expect(wrong.exitCode).toBe(2);
  expect(wrong.stderr.toString()).toContain("hsr/lightcone");
  expect(wrong.stderr.toString()).toContain("gi/weapon");
}));

test("同版本、不明版本及缺失旧基线都不请求邦布详情", () => fixture(async (workspace, root) => {
  let calls = 0;
  const request = async () => { calls++; return missing(); };
  expect(await refreshAtlasSource(root, { manifest: manifest(original), request })).toEqual({ status: "current", version: original });
  expect(await refreshAtlasSource(root, { manifest: manifest("3.4.4"), request })).toEqual({ status: "review", reason: "unproven-upgrade" });
  expect(await refreshAtlasSource(root, { manifest: async () => ({}), request })).toEqual({ status: "review", reason: "manifest-unavailable" });
  expect(await refreshAtlasSource(join(workspace, "missing"), { manifest: manifest(upgrade), request }))
    .toEqual({ status: "review", reason: "local-unverified" });
  await rename(join(root, "data/map.json"), join(root, "map-before.json"));
  expect(await refreshAtlasSource(root, { manifest: manifest(upgrade), request }))
    .toEqual({ status: "review", reason: "local-unverified" });
  expect(calls).toBe(0);
  expect(await readAtlasSnapshotVersion(root)).toBeNull();
  expect(await readdir(workspace)).toEqual(["atlas"]);
}));

test("404 使同 ID 现有详情或任一已下载图标缺失时拒绝发布", () => fixture(async (workspace, root) => {
  const detail = await refreshAtlasSource(root, { manifest: manifest(upgrade), request: source(upgrade, "detail-missing") });
  expect(detail).toEqual({ status: "invalid", issues: ["邦布 53001 缺少已有详情。", "邦布 53001 缺少已下载图标 detail.icon。"] });
  const media = await refreshAtlasSource(root, { manifest: manifest(upgrade), request: source(upgrade, "icon-missing") });
  expect(media).toEqual({ status: "invalid", issues: ["邦布 53001 缺少已下载图标 icon。", "邦布 53001 缺少已下载图标 detail.icon。"] });
  expect(await readAtlasSnapshotVersion(root)).toBeNull();
  expect(await readdir(workspace)).toEqual(["atlas"]);
}));

test("收集期间已发布较新指针时提前结束，保持竞争赢家", () => fixture(async (workspace, root) => {
  await mkdir(join(root, "snapshots"));
  await acquireAtlasSource(join(root, "snapshots/4"), scope(original), undefined, source(original));
  const collect = source(upgrade);
  let switched = false;
  const result = await refreshAtlasSource(root, { manifest: manifest(upgrade), request: async (url) => {
    if (!switched) {
      switched = true;
      expect((await publishAtlasCandidate(root, null, 4, scope(original))).status).toBe("published");
    }
    return collect(url);
  } });
  expect(result).toEqual({ status: "stale", current: 4 });
  expect(await readAtlasSnapshotVersion(root)).toBe(4);
  expect(await readdir(join(root, "snapshots"))).toEqual(["4"]);
  expect(await readdir(workspace)).toEqual(["atlas"]);
}));
