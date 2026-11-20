import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAtlasCandidate } from "./apply-candidate.ts";
import { createAtlasRuntimeCatalog, findBangboos, findEquipment, findSets } from "./catalog.ts";
import { publishAtlasCandidate, readAtlasSnapshotVersion } from "./publish-candidate.ts";
import { refreshAtlasSource } from "./refresh-source.ts";
import { acquireAtlasSource } from "./source-acquisition.ts";
import { atlasMaintenanceAliases, createAtlasMaintenance } from "./maintenance.ts";

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

test("图鉴旧维护命令仅允许主人，检查只读，更新仅尝试正式源且保留完整快照", async () => {
  const work = await mkdtemp(join(tmpdir(), "lotus-atlas-maintenance-"));
  const root = join(work, "atlas");
  const oldVersion = "3.3";
  const live = "3.4";
  const latest = "3.5.52";
  try {
    await acquireAtlasSource(root, scope(oldVersion), undefined, source(oldVersion));
    let manifestCalls = 0;
    let sourceCalls = 0;
    let missingIcon = true;
    const { commands } = createAtlasMaintenance(root, {
      async manifest() { manifestCalls++; return { zzz: { live, latest, available: [live, latest] } }; },
      async request(url) { sourceCalls++; expect(url).not.toContain(latest); return source(live, missingIcon ? "icon-missing" : "all")(url); },
    });
    const check = commands["#检查图鉴更新"];
    const update = commands["#更新图鉴"];
    expect(atlasMaintenanceAliases["图鉴检查更新"]).toBe("#检查图鉴更新");
    expect(atlasMaintenanceAliases["#图鉴更新"]).toBe("#更新图鉴");
    for (const alias of ["荷花图鉴检查更新", "#Lotus图鉴更新", "#LOTUS图鉴更新"]) {
      expect(atlasMaintenanceAliases[alias]).toBeUndefined();
    }
    expect(await check("", {})).toContain("只有 bot 主人");
    expect(await update("", { atlasMaintenance: true, isDelegated: true })).toContain("只有 bot 主人");
    expect(await update("zzz/bangboo", { atlasMaintenance: true })).toContain("请直接发送 #更新图鉴");
    expect(manifestCalls).toBe(0);

    const context = { atlasMaintenance: true } as const;
    expect(await check("", context)).toContain(`邦布 · ${oldVersion} → ${live}，可准备候选`);
    expect(manifestCalls).toBe(1);
    expect(sourceCalls).toBe(0);
    expect(await readAtlasSnapshotVersion(root)).toBeNull();
    const pending = update("", context);
    expect(await update("", context)).toContain("已有图鉴更新正在进行");
    expect(await pending).toContain("邦布 · 候选校验未通过，保留现有资料");
    expect(await readAtlasSnapshotVersion(root)).toBeNull();
    expect(manifestCalls).toBe(2);
    expect(sourceCalls).toBeGreaterThan(0);

    missingIcon = false;
    expect(await update("", context)).toContain(`邦布 · 已更新至 ${live}`);
    expect(await readAtlasSnapshotVersion(root)).toBe(1);
    const after = sourceCalls;
    expect(await update("", context)).toContain(`邦布 · 已是同一正式版本 ${live}`);
    expect(sourceCalls).toBe(after);

    const { commands: explicit } = createAtlasMaintenance(root, { dataOverride: join(root, "data"), manifest: async () => ({ zzz: { live, available: [live] } }) });
    expect(await explicit["#检查图鉴更新"]("", context)).toContain(`邦布 · ${oldVersion} → ${live}`);
    expect(await explicit["#更新图鉴"]("", context)).toContain("当前使用显式图鉴数据目录");
    expect(await readAtlasSnapshotVersion(root)).toBe(1);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("定时与手动共用分类、发布互斥和生命周期，失败后下次重新检查", () => fixture(async (work, root) => {
  const release = "3.4.5";
  let checks = 0;
  let fail = true;
  const controller = new AbortController();
  const { atlasSchedule, commands } = createAtlasMaintenance(root, {
    signal: controller.signal,
    updateConfig: { update_args: ["--page", "zzz=bangboo"], challenge_args: ["--page", "zzz=character"] },
    async manifest() {
      checks++;
      if (fail) throw new Error("fixture temporary failure");
      return { zzz: { live: release, available: [release] } };
    },
    request: source(release),
  });
  expect(atlasSchedule.challenge.cron).toBeUndefined();
  expect(await atlasSchedule.challenge.run()).toContain("未启用");
  expect(checks).toBe(0);

  const pending = atlasSchedule.version.run();
  expect(await commands["#更新图鉴"]("", { atlasMaintenance: true })).toContain("已有图鉴更新正在进行");
  expect(await pending).toContain("图鉴版本清单不可用");
  expect(await readAtlasSnapshotVersion(root)).toBeNull();
  expect(checks).toBe(1);

  fail = false;
  const published = await atlasSchedule.version.run();
  expect(published).toContain(`邦布 · 已更新至 ${release}`);
  expect(published).not.toContain("音擎");
  expect(await readAtlasSnapshotVersion(root)).toBe(1);
  expect(checks).toBe(2);

  controller.abort();
  expect(await atlasSchedule.version.run()).toContain("已中止");
  expect(checks).toBe(2);

  const unready = createAtlasMaintenance(join(work, "missing"), { updateConfig: {}, async manifest() { checks++; } });
  expect(await unready.atlasSchedule.challenge.run()).toContain("请先准备完整快照");
  expect(checks).toBe(2);
}));

const enginePrevious = "3.2";
const engineCurrent = "3.3";
const engineManifest = async () => ({ zzz: { live: engineCurrent, latest: upgrade, available: [engineCurrent, upgrade] } });
function engineSource(version: string, id = 13001) {
  const name = `样例音擎 ${id}`;
  const asset = "Weapon_A_Refresh";
  return async (url: string) => {
    if (url.endsWith(`/${version}/weapon.json`)) {
      return Response.json({ [id]: { zh: name, icon: asset, rank: 3, type: 4, atk: 40 } });
    }
    if (url.endsWith(`/${version}/zh/weapon/${id}.json`)) return Response.json({
      id, name, code_name: asset, rarity: 3, weapon_type: { 4: { name: "样例专精" } },
      icon: `Assets/NapResources/UI/Sprite/A1DynamicLoad/ItemIconWeapon/UnPacker/${asset}.png`,
      desc: "官方说明。", desc2: "其他原文。", desc3: "其他原文。", materials: "10:1",
      base_property: { name: "基础攻击力", value: 40 }, rand_property: { name: "防御力", value: 800, format: "%" },
      level: Object.fromEntries(Array.from({ length: 61 }, (_, index) => [index, { rate: 0, rate2: 0 }])),
      stars: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [index, { star_rate: 0, rand_rate: 0 }])),
      talents: Object.fromEntries([1, 2, 3, 4, 5].map((rank) => [rank, { name: "效果", desc: "样例效果。" }])),
    });
    if (url.endsWith(`/assets/zzz/${asset}.webp`)) return new Response(new Uint8Array(webp));
    throw new Error("刷新请求超出了音擎分类。");
  };
}

async function seedEngines(workspace: string, root: string, version = enginePrevious) {
  const donor = join(workspace, "weapon");
  const selected = [{ game: "zzz", pageId: "weapon", version }] as const;
  await acquireAtlasSource(donor, selected, undefined, engineSource(version));
  expect((await applyAtlasCandidate(root, donor, selected)).status).toBe("published");
  await rm(donor, { recursive: true });
}

test("音擎刷新只请求和发布选中的分类并保留邦布", () => fixture(async (workspace, root) => {
  await seedEngines(workspace, root);
  expect(await refreshAtlasSource(root, { pageId: "weapon", manifest: engineManifest, request: engineSource(engineCurrent, 13002) }))
    .toMatchObject({ status: "invalid", issues: ["音擎 13001 缺少已有音擎资料。"] });
  const result = await refreshAtlasSource(root, { pageId: "weapon", manifest: engineManifest, request: engineSource(engineCurrent) });
  expect(result).toMatchObject({ status: "published", version: 2 });
  const index = await createAtlasRuntimeCatalog(root).read();
  expect(findEquipment(index, "13001", "zzz")[0]?.version).toBe(engineCurrent);
  expect(findBangboos(index, "53001")[0]?.version).toBe(original);
  const unexpected = async () => { throw new Error("不应请求音擎详情"); };
  expect(await refreshAtlasSource(root, { pageId: "weapon", manifest: engineManifest, request: unexpected }))
    .toEqual({ status: "current", version: engineCurrent });
  await seedEngines(workspace, root, "3.4");
  expect(await refreshAtlasSource(root, { pageId: "weapon", manifest: engineManifest, request: unexpected }))
    .toEqual({ status: "review", reason: "unproven-upgrade" });
}));

const genshinOriginal = "7.2.52";
const genshinUpgrade = "7.2.53";
const genshinScope = [{ game: "gi", pageId: "weapon", version: genshinOriginal }] as const;
const genshinIndex = (version: string) => `https://static.nanoka.cc/gi/${version}/weapon.json`;
const genshinDetail = (version: string, id: number) => `https://static.nanoka.cc/gi/${version}/zh/weapon/${id}.json`;
const genshinArt = "https://static.nanoka.cc/assets/gi/UI_EquipIcon_Refresh.webp";
const genshinEventArt = "https://static.nanoka.cc/assets/gi/Sword_Template.webp";
const genshinManifest = (version: string, zenless = original) => async () => ({
  gi: { latest: version, available: [genshinOriginal, genshinUpgrade] },
  zzz: { live: enginePrevious, latest: zenless, available: [enginePrevious, original, upgrade] },
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
    .toEqual({ status: "current", version: enginePrevious });
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

const discLive = "3.3";
const discPrevious = "3.2";
const discScope = { game: "zzz", pageId: "equipment" } as const;
const discManifest = async () => ({ zzz: { live: discLive, latest: original, available: [discLive, original] } });
const discIndex = (version: string) => `https://static.nanoka.cc/zzz/${version}/equipment.json`;
const discDetail = (version: string, id: number) => `https://static.nanoka.cc/zzz/${version}/zh/equipment/${id}.json`;
const discIcon = (id: number) => id === 32700 ? "SuitBranch&BladeSong" : `SuitFixture${id}`;
const discAsset = (id: number) => `https://static.nanoka.cc/assets/zzz/${discIcon(id)}.webp`;
function discSource(version: string, ids: readonly number[] = [31000]) {
  const rows = ids.map((id) => ({
    id, icon: `UI/Sprite/A1DynamicLoad/IconSuit/UnPacker/${discIcon(id)}.png`,
    zh: { name: `测试驱动盘 ${id} `, desc2: "暴击率+8%。", desc4: "造成的伤害提高15%。" },
  }));
  return async (url: string) => {
    if (url === discIndex(version)) return Response.json(Object.fromEntries(rows.map(({ id, icon, zh }) => [id, { icon, zh }])));
    const row = rows.find(({ id }) => url === discDetail(version, id));
    if (row) return Response.json({ id: row.id, icon: row.icon, icon2: row.icon, ...row.zh, story: "套装故事原文。" });
    if (ids.some((id) => url === discAsset(id))) return new Response(new Uint8Array(webp));
    throw new Error(`意外的驱动盘来源请求 ${url}`);
  };
}

test("驱动盘按正式版单类更新，保留旧的三处原图引用和两页实际数据", () => fixture(async (workspace, root) => {
  const donor = join(workspace, "drive-disc");
  const scope = [{ ...discScope, version: discPrevious }];
  await acquireAtlasSource(donor, scope, undefined, discSource(discPrevious));
  expect((await applyAtlasCandidate(root, donor, scope)).status).toBe("published");
  await rm(donor, { recursive: true });
  const calls: string[] = [];
  const collect = discSource(discLive, [31000, 32700]);
  const request = async (url: string) => { calls.push(url); return collect(url); };
  expect(await refreshAtlasSource(root, { selection: "zzz/equipment", manifest: discManifest, request }))
    .toEqual({ status: "published", version: 2, directory: join(root, "snapshots/2/data") });
  expect(calls).toEqual([discIndex(discLive), discDetail(discLive, 31000), discAsset(31000),
    discDetail(discLive, 32700), discAsset(32700)]);
  const catalog = createAtlasRuntimeCatalog(root);
  const index = await catalog.read();
  const [disc] = findSets(index, "32700", "zzz");
  const artwork = "gallery/zzz/SuitBranch&BladeSong.webp";
  expect(await catalog.setDetails(disc!)).toMatchObject({
    name: "测试驱动盘 32700", version: discLive, parts: [], artwork, story: "套装故事原文。",
    effects: [{ pieces: 2, text: "暴击率+8%。" }, { pieces: 4, text: "造成的伤害提高15%。" }],
  });
  const item = await Bun.file(join(catalog.assetRoot(disc!), disc!.path)).json();
  expect(item.meta.images.map(({ fieldPath, localPath }: { fieldPath: string; localPath: string }) => [fieldPath, localPath]))
    .toEqual([["icon", artwork], ["detail.icon", artwork], ["detail.icon2", artwork]]);
  expect(findBangboos(index, "53001")[0]?.version).toBe(original);
  calls.length = 0;
  expect(await refreshAtlasSource(root, { selection: "zzz/equipment", manifest: discManifest, request }))
    .toEqual({ status: "current", version: discLive });
  expect(calls).toEqual([]);
}));

test("驱动盘来源未正式发布、缺原图或丢失既有资料时保留快照", () => fixture(async (workspace) => {
  const root = join(workspace, "drive-disc");
  await acquireAtlasSource(root, [{ ...discScope, version: "3.4" }], undefined, discSource("3.4"));
  const unexpected = async () => { throw new Error("禁止请求详情"); };
  expect(await refreshAtlasSource(root, { selection: "zzz/equipment", manifest: discManifest, request: unexpected }))
    .toEqual({ status: "review", reason: "unproven-upgrade" });
  expect(await refreshAtlasSource(root, { selection: "zzz/equipment", manifest: manifest(original), request: unexpected }))
    .toEqual({ status: "review", reason: "manifest-unavailable" });
  await rm(root, { recursive: true });
  await acquireAtlasSource(root, [{ ...discScope, version: discPrevious }], undefined, discSource(discPrevious));
  const run = (request: ReturnType<typeof discSource>) => refreshAtlasSource(root, { selection: "zzz/equipment", manifest: discManifest, request });
  const collect = discSource(discLive);
  await expect(run(async (url) => url === discAsset(31000) ? missing() : collect(url))).rejects.toThrow("图标缺失");
  await expect(run(async (url) => {
    const response = await collect(url);
    if (url !== discDetail(discLive, 31000)) return response;
    return Response.json({ ...await response.json(), icon2: "unknown", story: "" });
  })).rejects.toThrow("详情与来源索引");
  expect(await run(discSource(discLive, [34200]))).toMatchObject({ status: "invalid", issues: ["驱动盘 31000 缺少已有套装资料。"] });
  expect(await readAtlasSnapshotVersion(root)).toBeNull();
  expect(await readdir(workspace)).toEqual(["atlas", "drive-disc"]);
}));

test("刷新 CLI 接受已支持的游戏和分类组合", () => fixture(async (workspace) => {
  const script = join(import.meta.dir, "refresh-source.ts");
  const absent = join(workspace, "missing");
  for (const selection of ["hsr/lightcone", "zzz/bangboo", "zzz/weapon", "gi/weapon", "zzz/equipment", "zzz/boss", "zzz/shiyu"]) {
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

test.each(["gi", "hsr"] as const)("%s 成就更新保留分组和条目，正式版才可发布", async (game) => {
  const work = await mkdtemp(join(tmpdir(), "lotus-atlas-achievement-refresh-"));
  const root = join(work, "atlas");
  const pageId = "achievement/achievement";
  const category = game === "gi" ? "0" : "1";
  const iconName = "UI_AchievementIcon_O001";
  const selection = game === "gi" ? "gi/achievement/achievement" : "hsr/achievement/achievement";
  const base = { id: Number(category), name: "成就样例", ...(game === "gi" ? { icon: iconName } : {}) };
  const row = (id: number) => ({ id, name: `成就 ${id}`, desc: "达成条件" });
  const urls: string[] = [];
  let live = "1.0";
  let entries = [row(82001), row(82002)];
  const request = async (url: string) => {
    urls.push(url);
    if (url === `https://static.nanoka.cc/${game}/${live}/zh/${pageId}.json`) {
      return Response.json({ [category]: { ...base, list: entries } });
    }
    if (game === "gi" && url === `https://static.nanoka.cc/assets/gi/${iconName}.webp`) {
      return new Response(new Uint8Array(webp));
    }
    throw new Error(`意外的来源夹具请求 ${url}`);
  };
  try {
    await acquireAtlasSource(root, [{ game, pageId, version: live }], undefined, request);
    const catalog = createAtlasRuntimeCatalog(root);
    const ids = async () => (await catalog.read()).pages
      .flatMap(page => page.achievementCategories ?? []).flatMap(({ entries }) => entries.map(({ id }) => id));
    expect(await ids()).toEqual(["82001", "82002"]);

    const { commands } = createAtlasMaintenance(root, {
      manifest: async () => ({ [game]: { live, latest: "2.0", available: [live, "2.0"] } }), request,
      updateConfig: { update_args: ["--pages", selection.replace("/", "=")] },
    });
    const owner = { atlasMaintenance: true } as const;
    urls.length = 0;
    expect(await commands["#更新图鉴"]("", owner)).toContain("已是同一正式版本 1.0");
    expect(urls).toEqual([]);

    live = "1.1";
    entries = [row(82001), row(82003)];
    expect(await commands["#检查图鉴更新"]("", owner)).toContain("1.0 → 1.1，可准备候选");
    expect(urls).toEqual([]);
    expect(await commands["#更新图鉴"]("", owner)).toContain("候选校验未通过");
    expect(await readAtlasSnapshotVersion(root)).toBeNull();
    expect(await ids()).toEqual(["82001", "82002"]);

    entries = [row(82001), row(82002), row(82003)];
    urls.length = 0;
    expect(await commands["#更新图鉴"]("", owner)).toContain("已更新至 1.1");
    expect(await readAtlasSnapshotVersion(root)).toBe(1);
    expect(await ids()).toEqual(["82001", "82002", "82003"]);
    expect(urls).toEqual([
      `https://static.nanoka.cc/${game}/1.1/zh/${pageId}.json`,
      ...(game === "gi" ? [`https://static.nanoka.cc/assets/gi/${iconName}.webp`] : []),
    ]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("绝区零成就更新保留一级分类、空子分类、条目与互斥表，只抓正式版", async () => {
  const work = await mkdtemp(join(tmpdir(), "lotus-atlas-zzz-achievement-refresh-"));
  const root = join(work, "atlas");
  const selection = "zzz/achievement/achievement";
  const pageId = "achievement/achievement";
  const original = {
    category: {
      "1": { name: "战术", group: { "101": { name: "挑战", sort: 1 }, "102": { name: "待收录", sort: 2 } } },
      "2": { name: "未收录", group: {} },
    },
    achievement: { "1001": { group: 101, name: "胜利", desc: "完成挑战" } },
    mutual_type: { "99": { sample: true } },
  };
  let candidate = structuredClone(original);
  let live = "3.2";
  const urls: string[] = [];
  const manifest = async () => ({ zzz: { live, latest: "3.4.4+3", available: [live, "3.4.4+3"] } });
  const request = async (url: string) => {
    urls.push(url);
    if (url !== `https://static.nanoka.cc/zzz/${live}/zh/${pageId}.json`) throw new Error("请求了非正式来源。");
    return Response.json(candidate);
  };
  try {
    await acquireAtlasSource(root, [{ game: "zzz", pageId, version: live }], undefined, request);
    const catalog = createAtlasRuntimeCatalog(root);
    const ids = async () => (await catalog.read()).pages.flatMap(page => page.achievementCategories ?? [])
      .flatMap(({ entries }) => entries.map(({ id }) => id));
    const { commands } = createAtlasMaintenance(root, {
      manifest, request, updateConfig: { update_args: ["--pages", "zzz=achievement/achievement"] },
    });
    const owner = { atlasMaintenance: true } as const;
    live = "3.3";
    urls.length = 0;
    expect(await commands["#检查图鉴更新"]("", owner)).toContain("3.2 → 3.3，可准备候选");
    expect(urls).toEqual([]);
    for (const [remove, expected] of [
      [(next: typeof candidate) => { Reflect.deleteProperty(next.achievement, "1001"); }, "条目 1001"],
      [(next: typeof candidate) => { Reflect.deleteProperty(next.category, "2"); }, "一级分类 2"],
      [(next: typeof candidate) => { Reflect.deleteProperty(next.category["1"].group, "102"); }, "子分类 102"],
      [(next: typeof candidate) => { Reflect.deleteProperty(next.mutual_type, "99"); }, "互斥数据 99"],
    ] as const) {
      candidate = structuredClone(original);
      Object.assign(candidate.achievement, { "1002": { group: 101, name: "新增", desc: "新的挑战" } });
      remove(candidate);
      const result = await refreshAtlasSource(root, { selection, manifest, request });
      expect(result).toMatchObject({ status: "invalid", issues: [`绝区零成就缺少已有${expected}。`] });
      expect(await readAtlasSnapshotVersion(root)).toBeNull();
      expect(await ids()).toEqual(["1001"]);
    }
    candidate = structuredClone(original);
    Object.assign(candidate.achievement, { "1002": { group: 101, name: "新增", desc: "新的挑战" } });
    expect(await commands["#更新图鉴"]("", owner)).toContain("已更新至 3.3");
    expect(await readAtlasSnapshotVersion(root)).toBe(1);
    expect(await ids()).toEqual(["1001", "1002"]);
    expect(new Set(urls)).toEqual(new Set([`https://static.nanoka.cc/zzz/3.3/zh/${pageId}.json`]));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
