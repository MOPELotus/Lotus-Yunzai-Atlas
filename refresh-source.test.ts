import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAtlasCandidate } from "./apply-candidate.ts";
import { createAtlasRuntimeCatalog, findBangboos, findEquipment, findSets } from "./catalog.ts";
import { publishAtlasCandidate, readAtlasSnapshotVersion } from "./publish-candidate.ts";
import { mazeSourceOutline } from "./maze-source-data.ts";
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
      updateConfig: { version_channel: "live", update_args: ["--page", "zzz=bangboo"] },
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

    const { commands: explicit } = createAtlasMaintenance(root, { dataOverride: join(root, "data"), updateConfig: { version_channel: "live", update_args: ["--page", "zzz=bangboo"] }, manifest: async () => ({ zzz: { live, available: [live] } }) });
    expect(await explicit["#检查图鉴更新"]("", context)).toContain(`邦布 · ${oldVersion} → ${live}`);
    expect(await explicit["#更新图鉴"]("", context)).toContain("当前使用显式图鉴数据目录");
    expect(await readAtlasSnapshotVersion(root)).toBe(1);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("聊天图鉴更新先回执再查版本，发送结果卡失败时回落到同一份文字", () => fixture(async (_work, root) => {
  const events: string[] = [];
  const { commands } = createAtlasMaintenance(root, {
    updateConfig: { version_channel: "latest", update_args: ["--page", "zzz=bangboo"] },
    async manifest() {
      events.push("读取版本");
      return { zzz: { latest: original, available: [original] } };
    },
  });
  let delivered = true;
  const context = { atlasMaintenance: true as const, reply(message: string | { readonly file: Uint8Array }) {
    if (typeof message === "string") {
      events.push(message);
      return true;
    }
    expect([...message.file.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    events.push("结果卡");
    return delivered;
  } };
  expect(await commands["#更新图鉴"]("", { ...context, isDelegated: true })).toContain("只有 bot 主人");
  expect(events).toEqual([]);
  expect(await commands["#更新图鉴"]("", context)).toEqual([]);
  expect(events).toEqual(["正在检查图鉴版本，随后增量更新有变化的分类。", "读取版本", "结果卡"]);
  delivered = false;
  expect(await commands["#检查图鉴更新"]("", context)).toContain("图鉴版本检查");
  expect(events.slice(-3)).toEqual(["正在检查图鉴版本差异。", "读取版本", "结果卡"]);
  expect(await commands["#重置图鉴"]("", context)).toContain("请发送 #全量更新图鉴 重新初始化");
  expect(events.at(-1)).toBe("结果卡");
}));

test("定时与手动共用分类、发布互斥和生命周期，失败后下次重新检查", () => fixture(async (work, root) => {
  const release = "3.4.5";
  let checks = 0;
  let fail = true;
  const controller = new AbortController();
  const manifestEntered = Promise.withResolvers<void>();
  const continueManifest = Promise.withResolvers<void>();
  const { atlasSchedule, commands } = createAtlasMaintenance(root, {
    signal: controller.signal,
    updateConfig: { version_channel: "live", update_args: ["--page", "zzz=bangboo"], challenge_args: ["--page", "zzz=character"] },
    async manifest() {
      checks++;
      if (fail) {
        manifestEntered.resolve();
        await continueManifest.promise;
        throw new Error("fixture temporary failure");
      }
      return { zzz: { live: release, available: [release] } };
    },
    request: source(release),
  });
  expect(atlasSchedule.challenge.cron).toBeUndefined();
  expect(await atlasSchedule.challenge.run()).toContain("未启用");
  expect(checks).toBe(0);

  expect(atlasSchedule.version.cron).toBeDefined();
  const pending = atlasSchedule.version.run();
  // Scheduled work first enters its queue; wait until it actually owns the update lock.
  await manifestEntered.promise;
  try {
    expect(await commands["#更新图鉴"]("", { atlasMaintenance: true })).toContain("已有图鉴更新正在进行");
    expect(checks).toBe(1);
  } finally {
    continueManifest.resolve();
  }
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

test("旧配置默认核对网站最新版，并能识别未更新或未准备的分类", () => fixture(async (_work, root) => {
  const listing = { zzz: { live: "3.3", latest: upgrade, available: ["3.3", upgrade] } };
  const owner = { atlasMaintenance: true } as const;
  const maintenance = createAtlasMaintenance(root, { manifest: async () => listing });
  const check = await maintenance.commands["#检查图鉴更新"]("", owner);
  expect(check).toContain("网站最新版");
  expect(check).toContain("本次范围 30 类");
  expect(check).toContain(`邦布 · ${original} → ${upgrade}`);
  expect(check).toContain(`绝区零角色 · 未准备 → ${upgrade}`);
  expect(check).toContain("星铁精英组 · 来源版本未知");
  const refused = await maintenance.commands["#更新图鉴"]("", owner);
  expect(refused).toContain("本次范围未发布");
  expect(await readAtlasSnapshotVersion(root)).toBeNull();
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
  expect((await readdir(workspace)).sort()).toEqual(["atlas", "drive-disc"]);
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
      updateConfig: { version_channel: "live", update_args: ["--pages", selection.replace("/", "=")] },
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
      manifest, request, updateConfig: { version_channel: "live", update_args: ["--pages", "zzz=achievement/achievement"] },
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

test("星铁遗器只更新正式版并保留旧记录、部件、套装效果及真实原图", async () => {
  const work = await mkdtemp(join(tmpdir(), "lotus-atlas-hsr-relicset-refresh-"));
  const root = join(work, "atlas");
  const iconName = "SpriteOutput/ItemIcon/71000.png";
  const setName = "原样套装";
  const pageId = "relicset";
  const selection = "hsr/relicset";
  const original = {
    name: setName, icon: iconName,
    parts: {
      "31011": { name: "头部" }, "31012": { name: "手部" },
      "31013": { name: "躯干" }, "31014": { name: "脚部" },
    },
    require_num: {
      "2": { desc: "治疗量提高<unbreak>#1[i]%</unbreak>。", param_list: [0.1] },
      "4": { desc: "恢复战技点。", param_list: [] },
    },
  };
  let candidate = structuredClone(original);
  let live = "4.6";
  let id = "101";
  let iconMissing = false;
  let detailMismatch = false;
  const manifest = async () => ({ hsr: { live, latest: "4.7.52", available: [live, "4.7.52"] } });
  const requests: string[] = [];
  const request = async (url: string) => {
    requests.push(url);
    if (url === `https://static.nanoka.cc/hsr/${live}/relicset.json`) {
      const set = Object.fromEntries(Object.entries(candidate.require_num)
        .map(([pieces, { desc, param_list }]) => [pieces, { zh: desc, ParamList: param_list }]));
      return Response.json({ [id]: { zh: setName, icon: iconName, set } });
    }
    if (url === `https://static.nanoka.cc/hsr/${live}/zh/relicset/${id}.json`) {
      return Response.json(detailMismatch ? { ...candidate, name: "错误套装" } : candidate);
    }
    if (url === "https://static.nanoka.cc/assets/hsr/itemfigures/71000.webp") {
      return iconMissing ? missing() : new Response(new Uint8Array(webp));
    }
    throw new Error(`不应请求 ${url}`);
  };
  try {
    await acquireAtlasSource(root, [{ game: "hsr", pageId, version: live }], undefined, request);
    const catalog = createAtlasRuntimeCatalog(root);
    const activeSet = async () => {
      const [set] = findSets(await catalog.read(), setName, "hsr");
      return set && catalog.setDetails(set);
    };
    const before = await activeSet();
    if (!before) throw new Error("旧版星铁遗器测试数据未加载。");
    expect(before?.parts).toHaveLength(4);
    const { commands } = createAtlasMaintenance(root, {
      manifest, request, updateConfig: { version_channel: "live", update_args: ["--pages", "hsr=relicset"] },
    });
    live = "4.7";
    requests.length = 0;
    const owner = { atlasMaintenance: true } as const;
    expect(await commands["#检查图鉴更新"]("", owner)).toContain("4.6 → 4.7，可准备候选");
    expect(requests).toEqual([]);

    id = "102";
    expect(await refreshAtlasSource(root, { selection, manifest, request })).toMatchObject({
      status: "invalid", issues: ["星铁遗器 101 缺少已有条目。"],
    });
    id = "101";
    candidate.parts["31014"] = { name: "不同部位" };
    Object.assign(candidate.parts, { "31015": candidate.parts["31014"] });
    Reflect.deleteProperty(candidate.parts, "31014");
    expect(await refreshAtlasSource(root, { selection, manifest, request })).toMatchObject({
      status: "invalid", issues: ["星铁遗器 101 缺少已有部位或套装效果。"],
    });
    candidate = structuredClone(original);
    iconMissing = true;
    expect(await commands["#更新图鉴"]("", owner)).toContain("更新未完成");
    iconMissing = false;
    detailMismatch = true;
    expect(await commands["#更新图鉴"]("", owner)).toContain("更新未完成");
    expect(await readAtlasSnapshotVersion(root)).toBeNull();
    expect(await activeSet()).toEqual(before);
    detailMismatch = false;
    requests.length = 0;
    expect(await commands["#更新图鉴"]("", owner)).toContain("已更新至 4.7");
    expect(await readAtlasSnapshotVersion(root)).toBe(1);
    expect(await activeSet()).toEqual({ ...before, version: "4.7" });
    expect(requests).toEqual([
      "https://static.nanoka.cc/hsr/4.7/relicset.json",
      "https://static.nanoka.cc/hsr/4.7/zh/relicset/101.json",
      "https://static.nanoka.cc/assets/hsr/itemfigures/71000.webp",
    ]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("原神圣遗物更新校验五件部位，已核原缺图例外不会让真实部位图降级", async () => {
  const work = await mkdtemp(join(tmpdir(), "lotus-atlas-gi-artifact-refresh-"));
  const root = join(work, "atlas");
  const pageId = "artifact";
  const selection = "gi/artifact";
  const name = "样例套装";
  const id = 15004;
  const icon = "UI_RelicIcon_15004_4";
  const rank = [4, 5];
  const slots = ["equip_ring", "equip_necklace", "equip_dress", "equip_bracer", "equip_shoes"];
  const sourceEffects = { "19": { name: { zh: name }, desc: { zh: "加成一" } }, "20": { name: { zh: name }, desc: { zh: "加成二" } } };
  const original = {
    id, icon, rank, need: [2, 4],
    affix: Object.entries(sourceEffects).map(([key, effect]) => ({ affix_id: Number(key), name, desc: effect.desc.zh })),
    parts: Object.fromEntries(slots.map((slot, index) => [slot, { name: slot, icon: `UI_RelicIcon_15004_${index + 1}` }])),
  };
  let candidate = structuredClone(original);
  let live = "7.1";
  let missingIcon: string | undefined;
  const request = async (url: string) => {
    if (url === `https://static.nanoka.cc/gi/${live}/artifact.json`) {
      return Response.json({ [id]: { id, icon, rank, set: sourceEffects } });
    }
    if (url === `https://static.nanoka.cc/gi/${live}/zh/artifact/${id}.json`) return Response.json(candidate);
    const match = /\/assets\/gi\/(UI_RelicIcon_15004_[1-5])\.webp$/u.exec(url);
    if (!match) throw new Error(`不应请求 ${url}`);
    return match[1] === missingIcon ? missing() : new Response(new Uint8Array(webp));
  };
  try {
    await acquireAtlasSource(root, [{ game: "gi", pageId, version: live }], undefined, request);
    const manifest = async () => ({ gi: { live, latest: "7.2.52", available: [live, "7.2.52"] } });
    live = "7.2";
    missingIcon = "UI_RelicIcon_15004_1";
    expect(await refreshAtlasSource(root, { selection, manifest, request })).toMatchObject({
      status: "invalid", issues: ["原神圣遗物 15004 缺少已下载图标 detail.parts.equip_ring.icon。"],
    });
    missingIcon = undefined;
    Reflect.deleteProperty(candidate.parts, "equip_ring");
    await expect(refreshAtlasSource(root, { selection, manifest, request })).rejects.toThrow("详情与来源索引");
    candidate = structuredClone(original);
    candidate.affix[0]!.desc = "未证实效果";
    await expect(refreshAtlasSource(root, { selection, manifest, request })).rejects.toThrow("详情与来源索引");
    expect(await readAtlasSnapshotVersion(root)).toBeNull();

    candidate = structuredClone(original);
    expect(await refreshAtlasSource(root, { selection, manifest, request })).toMatchObject({ status: "published", version: 1 });
    const catalog = createAtlasRuntimeCatalog(root);
    const [entry] = findSets(await catalog.read(), name, "gi");
    expect(await catalog.setDetails(entry!)).toMatchObject({ version: live, parts: slots.map(slot => ({ id: slot })) });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("星铁敌人数值更新只读正式索引并保留已有敌人、变体及阶段", async () => {
  const work = await mkdtemp(join(tmpdir(), "lotus-atlas-hsr-monstervalue-refresh-"));
  const root = join(work, "atlas");
  const selection = "hsr/monstervalue";
  const pageId = "monstervalue";
  const id = "1004011";
  const values = {
    Rank: "LittleBoss", AttackBase: 19, DefenceBase: 220, HPBase: 100,
    SpeedBase: null, StanceBase: 90, StatusResistanceBase: 0.3,
    MaxMonsterPhase: 2, PhaseList: [{ phase_num: 1, phase_max_hp_ratio: 1 }, { phase_num: 2, phase_max_hp_ratio: 0.8 }],
    child: [1004011, 100401101].map(Id => ({
      Id, AttackModifyRatio: 1, DefenceModifyRatio: 1, EliteGroup: 10, HPModifyRatio: 1, SpeedModifyRatio: 1,
      SpeedModifyValue: -10, StanceModifyRatio: 1, HardLevelGroup: 2, StanceWeakList: ["Wind"],
    })),
  };
  let candidate = structuredClone(values);
  let key = id;
  let live = "4.6";
  const urls: string[] = [];
  const request = async (url: string) => {
    urls.push(url);
    if (url !== `https://static.nanoka.cc/hsr/${live}/monstervalue.json`) throw new Error(`不应请求 ${url}`);
    return Response.json({ [key]: candidate });
  };
  try {
    await acquireAtlasSource(root, [{ game: "hsr", pageId, version: live }], undefined, request);
    const manifest = async () => ({ hsr: { live, latest: "4.7.52", available: [live, "4.7.52"] } });
    const { commands } = createAtlasMaintenance(root, {
      manifest, request, updateConfig: { version_channel: "live", update_args: ["--pages", "hsr=monstervalue"] },
    });
    const owner = { atlasMaintenance: true } as const;
    live = "4.7";
    urls.length = 0;
    expect(await commands["#检查图鉴更新"]("", owner)).toContain("4.6 → 4.7，可准备候选");
    expect(urls).toEqual([]);

    key = "1004012";
    expect(await refreshAtlasSource(root, { selection, manifest, request })).toMatchObject({
      status: "invalid", issues: [`星铁敌人数值 ${id} 缺少已有条目。`],
    });
    key = id;
    candidate.child.pop();
    expect(await refreshAtlasSource(root, { selection, manifest, request })).toMatchObject({
      status: "invalid", issues: [`星铁敌人数值 ${id} 缺少已有变体或阶段。`],
    });
    candidate = structuredClone(values);
    candidate.MaxMonsterPhase = 1;
    candidate.PhaseList.pop();
    expect(await refreshAtlasSource(root, { selection, manifest, request })).toMatchObject({
      status: "invalid", issues: [`星铁敌人数值 ${id} 缺少已有变体或阶段。`],
    });
    candidate = structuredClone(values);
    candidate.PhaseList[0]!.phase_num = 2;
    await expect(refreshAtlasSource(root, { selection, manifest, request })).rejects.toThrow("索引条目结构无效");
    expect(await readAtlasSnapshotVersion(root)).toBeNull();

    candidate = structuredClone(values);
    candidate.child.push({ ...values.child[1]!, Id: 100401102 });
    candidate.PhaseList.push({ phase_num: 3, phase_max_hp_ratio: 1 });
    candidate.MaxMonsterPhase = 3;
    urls.length = 0;
    expect(await commands["#更新图鉴"]("", owner)).toContain("已更新至 4.7");
    expect(await readAtlasSnapshotVersion(root)).toBe(1);
    const published = join(root, "snapshots/1/data");
    const map = await Bun.file(join(published, "map.json")).json();
    const page = map.games.hsr.locales.zh.pages.monstervalue;
    expect(page.records[id].hasDetail).toBe(false);
    const record = await Bun.file(join(published, page.records[id].path)).json();
    expect(record.content).toEqual({ list: candidate, detail: null });
    expect(record.meta.images).toEqual([]);
    expect(urls).toEqual(["https://static.nanoka.cc/hsr/4.7/monstervalue.json"]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test.each(["EliteGroup", "HardLevelGroup", "InfiniteEliteGroup"] as const)(
  "星铁 %s 保留原组键与字段，允许重排或插入",
  async (pageId) => {
    const work = await mkdtemp(join(tmpdir(), "lotus-atlas-hsr-group-refresh-"));
    const root = join(work, "atlas");
    const selection = `hsr/${pageId}` as const;
    const stats = { AttackRatio: 1, DefenceRatio: 1, HPRatio: 1, SpeedRatio: 1, StanceRatio: 1 };
    const hard = pageId === "HardLevelGroup";
    const row = (id: number, level: number) => hard
      ? { ...stats, HardLevelGroup: id, Level: level, CombatPowerList: [1, 2, 3, 4], StatusResistance: 0.2 }
      : { ...stats, EliteGroup: id };
    const first = row(11, 1);
    const second = row(hard ? 11 : 12, 2);
    const added = row(13, 1);
    let candidate = [first, second];
    let live = "4.6";
    const requests: string[] = [];
    const request = async (url: string) => {
      requests.push(url);
      if (url !== `https://static.nanoka.cc/hsr/${live}/${pageId}.json`) throw new Error(`不应请求 ${url}`);
      return Response.json(candidate);
    };
    try {
      await acquireAtlasSource(root, [{ game: "hsr", pageId, version: live }], undefined, request);
      const manifest = async () => ({ hsr: { live, latest: "4.7.52", available: [live, "4.7.52"] } });
      const { commands } = createAtlasMaintenance(root, {
        manifest, request, updateConfig: { version_channel: "live", update_args: ["--pages", `hsr=${pageId}`] },
      });
      const owner = { atlasMaintenance: true } as const;
      live = "4.7";
      requests.length = 0;
      expect(await commands["#检查图鉴更新"]("", owner)).toContain("4.6 → 4.7，可准备候选");
      expect(requests).toEqual([]);

      candidate = [second, added];
      expect(await refreshAtlasSource(root, { selection, manifest, request })).toMatchObject({
        status: "invalid", issues: [expect.stringContaining(`${hard ? "11/1" : "11"} 缺少已有条目`)],
      });
      candidate = [added, first, first];
      await expect(refreshAtlasSource(root, { selection, manifest, request })).rejects.toThrow("重复主键");
      candidate = [{ ...first, HPRatio: -1 }, second];
      await expect(refreshAtlasSource(root, { selection, manifest, request })).rejects.toThrow("结构错误");
      if (hard) {
        const withoutStatus = { ...first };
        Reflect.deleteProperty(withoutStatus, "StatusResistance");
        candidate = [second, added, withoutStatus];
        expect(await refreshAtlasSource(root, { selection, manifest, request })).toMatchObject({
          status: "invalid", issues: [expect.stringContaining("11/1 缺少已有字段")],
        });
      }
      expect(await readAtlasSnapshotVersion(root)).toBeNull();

      candidate = [added, second, { ...first, AttackRatio: 1.1 }];
      requests.length = 0;
      expect(await commands["#更新图鉴"]("", owner)).toContain("已更新至 4.7");
      expect(await readAtlasSnapshotVersion(root)).toBe(1);
      const published = join(root, "snapshots/1/data");
      const map = await Bun.file(join(published, "map.json")).json();
      const page = map.games.hsr.locales.zh.pages[pageId];
      expect(Object.keys(page.records)).toEqual(["0", "1", "2"]);
      for (const [position, row] of candidate.entries()) {
        const record = await Bun.file(join(published, page.records[position].path)).json();
        expect(record.content).toEqual({ list: row, detail: null });
        expect(record.meta.images).toEqual([]);
      }
      expect(requests).toEqual([`https://static.nanoka.cc/hsr/4.7/${pageId}.json`]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

test("星铁敌人正式更新校验同版本身份、原图与数值表的变体关联", async () => {
  const work = await mkdtemp(join(tmpdir(), "lotus-atlas-hsr-monster-refresh-"));
  const root = join(work, "atlas");
  const numberSource = join(work, "stats");
  const selection = "hsr/monster";
  const id = "1002011";
  const name = "冰锋";
  const icon = "SpriteOutput/MonsterFigure/Monster_1002011.png";
  const variants = [1002011, 100201101];
  let candidate = [...variants];
  let live = "4.6";
  let badDetail = false;
  let badIcon = false;
  const urls: string[] = [];
  const request = async (url: string) => {
    urls.push(url);
    if (url === `https://static.nanoka.cc/hsr/${live}/monster.json`) {
      return Response.json({ [id]: { zh: name, icon, rank: "MinionLv2", weak: ["Fire"], child: candidate } });
    }
    if (url === `https://static.nanoka.cc/hsr/${live}/zh/monster/${id}.json`) {
      return Response.json({
        id: Number(id), name: badDetail ? "错误敌人" : name, rank: "MinionLv2", image_path: icon,
        desc: "守护者创造的冰矛。", attack_base: 18, defence_base: 210, hp_base: 70,
        speed_base: 100, stance_base: 60, status_resistance_base: 0.2, drop: [],
        child: candidate.map(id => ({
          id, skill_list: [], damage_type_resistance: [], stance_weak_list: ["Fire"], elite_group: 1, hard_level_group: 1,
        })),
      });
    }
    if (url === "https://static.nanoka.cc/assets/hsr/monsterfigure/Monster_1002011.webp") {
      return badIcon ? missing() : new Response(new Uint8Array(webp));
    }
    throw new Error(`不应请求 ${url}`);
  };
  const numeric = [...variants, 100201102];
  const numbers = {
    Rank: "MinionLv2", AttackBase: 18, DefenceBase: 210, HPBase: 70, SpeedBase: 100,
    StanceBase: 60, StatusResistanceBase: 0.2,
    child: numeric.map(Id => ({ Id, AttackModifyRatio: 1, DefenceModifyRatio: 1, EliteGroup: 1,
      HPModifyRatio: 1, SpeedModifyRatio: 1, SpeedModifyValue: null, StanceModifyRatio: 1,
      HardLevelGroup: 1, StanceWeakList: ["Fire"] })),
  };
  try {
    await acquireAtlasSource(root, [{ game: "hsr", pageId: "monster", version: live }], undefined, request);
    const valuePlan = [{ game: "hsr", pageId: "monstervalue", version: "4.7" }] as const;
    await acquireAtlasSource(numberSource, valuePlan, undefined, async () => Response.json({ [id]: numbers }));
    expect((await applyAtlasCandidate(root, numberSource, valuePlan)).status).toBe("published");
    const manifest = async () => ({ hsr: { live, latest: "4.7.52", available: [live, "4.7.52"] } });
    const { commands } = createAtlasMaintenance(root, {
      manifest, request, updateConfig: { version_channel: "live", update_args: ["--pages", "hsr=monster"] },
    });
    const owner = { atlasMaintenance: true } as const;
    live = "4.7";
    urls.length = 0;
    expect(await commands["#检查图鉴更新"]("", owner)).toContain("4.6 → 4.7，可准备候选");
    expect(urls).toEqual([]);

    expect(await refreshAtlasSource(root, { selection, manifest, request })).toMatchObject({
      status: "invalid", issues: [`星铁敌人 ${id} 缺少同版本数值表关联的变体。`],
    });
    candidate = [variants[0]!];
    expect(await refreshAtlasSource(root, { selection, manifest, request })).toMatchObject({
      status: "invalid", issues: [`星铁敌人 ${id} 缺少已有变体或阶段。`, `星铁敌人 ${id} 缺少同版本数值表关联的变体。`],
    });
    candidate = numeric;
    badDetail = true;
    await expect(refreshAtlasSource(root, { selection, manifest, request })).rejects.toThrow("详情与来源索引");
    badDetail = false;
    badIcon = true;
    await expect(refreshAtlasSource(root, { selection, manifest, request })).rejects.toThrow("来源原图缺失");
    expect(await readAtlasSnapshotVersion(root)).toBe(1);

    badIcon = false;
    urls.length = 0;
    expect(await commands["#更新图鉴"]("", owner)).toContain("已更新至 4.7");
    expect(await readAtlasSnapshotVersion(root)).toBe(2);
    const active = join(root, "snapshots/2/data");
    const map = await Bun.file(join(active, "map.json")).json();
    const records = map.games.hsr.locales.zh.pages;
    const stats = await Bun.file(join(active, records.monstervalue.records[id].path)).json();
    const monster = await Bun.file(join(active, records.monster.records[id].path)).json();
    expect(stats.content.list).toEqual(numbers);
    expect(monster.content.list.child).toEqual(numeric);
    expect(monster.meta.images.map(({ fieldPath }: { fieldPath: string }) => fieldPath))
      .toEqual(["icon", "derived.monsterFigure", "detail.image_path"]);
    expect(urls).toEqual([
      "https://static.nanoka.cc/hsr/4.7/monster.json",
      "https://static.nanoka.cc/hsr/4.7/zh/monster/1002011.json",
      "https://static.nanoka.cc/assets/hsr/monsterfigure/Monster_1002011.webp",
    ]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("混沌回忆更新保留实装窗口、历史期次和同版战斗倍率关联", async () => {
  const work = await mkdtemp(join(tmpdir(), "lotus-atlas-hsr-maze-refresh-"));
  const root = join(work, "atlas");
  const groupSource = join(work, "groups");
  const selection = "hsr/maze";
  const period = (id: string, name: string) => ({
    id, zh: name, begin: "", end: "",
    live_begin: "2026-11-01 04:00:00", live_end: "2026-12-12 04:00:00",
  });
  const original = { "1036": period("1036", "已有期间"), "1037": period("1037", "另一期") };
  let candidate = structuredClone(original);
  let live = "4.6";
  let missingDetail = false;
  let brokenGroup = false;
  const staged = { stage_id: 2001, level: 60, hard_level_group: 1, monster_list: [{ monster0: 1002011 }] };
  const request = async (url: string) => {
    if (url === `https://static.nanoka.cc/hsr/${live}/maze.json`) return Response.json(candidate);
    const hit = /\/zh\/maze\/(1036|1037)\.json$/u.exec(url);
    if (!hit || !url.includes(`/${live}/`)) throw new Error(`不应请求 ${url}`);
    const group_name = original[hit[1] as keyof typeof original].zh;
    if (missingDetail && hit[1] === "1036") return missing();
    return Response.json([{
      id: 101, name: "首层", group_name, challenge: [],
      event_id_list1: [{ ...staged, ...(brokenGroup && hit[1] === "1036" ? { level: 61 } : {}) }],
      event_id_list2: [],
    }]);
  };
  try {
    await acquireAtlasSource(root, [{ game: "hsr", pageId: "maze", version: live }], undefined, request);
    const group = [{ game: "hsr", pageId: "HardLevelGroup", version: "4.7" }] as const;
    await acquireAtlasSource(groupSource, group, undefined, async () => Response.json([{
      HardLevelGroup: 1, Level: 60, AttackRatio: 1, HPRatio: 1, SpeedRatio: 1, StanceRatio: 1, CombatPowerList: [0, 0, 0, 0],
    }]));
    expect((await applyAtlasCandidate(root, groupSource, group)).status).toBe("published");
    const manifest = async () => ({ hsr: { live, latest: "4.7.52", available: [live, "4.7.52"] } });
    const { commands } = createAtlasMaintenance(root, {
      manifest, request, updateConfig: { version_channel: "live", update_args: ["--pages", "hsr=maze"] },
    });
    const owner = { atlasMaintenance: true } as const;
    live = "4.7";
    expect(await commands["#检查图鉴更新"]("", owner)).toContain("4.6 → 4.7，可准备候选");
    Reflect.deleteProperty(candidate, "1037");
    expect(await refreshAtlasSource(root, { selection, manifest, request })).toMatchObject({
      status: "invalid", issues: [expect.stringContaining("1037 缺少已有轮换资料")],
    });
    candidate = structuredClone(original);
    candidate["1036"].live_end = "2026-12-13 04:00:00";
    expect(await refreshAtlasSource(root, { selection, manifest, request })).toMatchObject({
      status: "invalid", issues: [expect.stringContaining("1036 与已有身份或实装窗口冲突")],
    });
    candidate = structuredClone(original);
    brokenGroup = true;
    expect(await refreshAtlasSource(root, { selection, manifest, request })).toMatchObject({
      status: "invalid", issues: [expect.stringContaining("1036 无法关联同版本星铁难度组 1/61")],
    });
    brokenGroup = false;
    missingDetail = true;
    expect(await commands["#更新图鉴"]("", owner)).toContain("更新未完成");
    expect(await readAtlasSnapshotVersion(root)).toBe(1);
    missingDetail = false;
    expect(await commands["#更新图鉴"]("", owner)).toContain("已更新至 4.7");
    expect(await readAtlasSnapshotVersion(root)).toBe(2);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("绝区零角色只从正式版更新，已有条目、等级和原图必须完整", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lotus-atlas-zzz-character-"));
  const root = join(workspace, "atlas");
  try {
    const old = "3.2";
    const live = "3.3";
    const icon = "IconRole01";
    const role = { zh: "安比", rank: 3, icon, code: "Anby" };
    const second = { zh: "比利", rank: 3, icon: "IconRole04", code: "Billy" };
    const level = Object.fromEntries(Array.from({ length: 6 }, (_, i) =>
      [i + 1, { level_min: i * 10, level_max: (i + 1) * 10, hp_max: 0, attack: 0, defence: 0 }]));
    const stats = { hp_max: 603, hp_growth: 818426, attack: 95, attack_growth: 54230, defence: 49, defence_growth: 66882,
      crit: 500, crit_damage: 5000 };
    let failure: "record" | "rank" | "portrait" | "mindscape" | undefined;
    const urls: string[] = [];
    const request = async (url: string) => {
      urls.push(url);
      if (url.endsWith("/character.json")) return Response.json(failure === "record" ? { "1061": second }
        : { "1011": role, ...(url.includes("/3.3/") ? { "1061": second } : {}) });
      const detail = /\/character\/(1011|1061).json$/u.exec(url);
      if (detail) {
        const id = Number(detail[1]);
        const listed = id === 1011 ? role : second;
        return Response.json({ id, name: listed.zh, icon: listed.icon, code_name: listed.code.toUpperCase(),
          rarity: failure === "rank" ? 4 : 3, stats, level, partner_info: { inter_knot_icon: "IconInterKnotRole0001" },
          skill: { basic: {} } });
      }
      if (failure === "portrait" && url.endsWith("/IconRole01.webp") || failure === "mindscape" && url.endsWith("/Mindscape_1011_1.webp")) return missing();
      return new Response(new Uint8Array(webp));
    };
    await acquireAtlasSource(root, [{ game: "zzz", pageId: "character", version: old }], undefined, request);
    urls.length = 0;
    const selection = "zzz/character" as const;
    const manifest = async () => ({ zzz: { live, latest: "3.4.1+20000001", available: [old, live, "3.4.1+20000001"] } });
    for (const [mode, message] of [["record", "缺少已有条目"], ["mindscape", "缺少已下载图标"]] as const) {
      failure = mode;
      const result = await refreshAtlasSource(root, { selection, manifest, request });
      expect(result).toMatchObject({ status: "invalid", issues: expect.arrayContaining([expect.stringContaining(message)]) });
      expect(await readAtlasSnapshotVersion(root)).toBeNull();
    }
    for (const [mode, message] of [["rank", "身份或等级不符"], ["portrait", "来源原图缺失"]] as const) {
      failure = mode;
      await expect(refreshAtlasSource(root, { selection, manifest, request })).rejects.toThrow(message);
      expect(await readAtlasSnapshotVersion(root)).toBeNull();
    }
    failure = undefined;
    const { commands } = createAtlasMaintenance(root, { updateConfig: { version_channel: "live", update_args: ["--page", "zzz=character"] }, manifest, request });
    expect(await commands["#检查图鉴更新"]("", { atlasMaintenance: true })).toContain(`${old} → ${live}`);
    expect(await commands["#更新图鉴"]("", { atlasMaintenance: true })).toContain(`绝区零角色 · 已更新至 ${live}`);
    expect(await readAtlasSnapshotVersion(root)).toBe(1);
    expect(urls.some(url => url.includes("3.4.1+20000001"))).toBe(false);
    const catalog = createAtlasRuntimeCatalog(root);
    const page = (await catalog.read()).pages.find(page => page.game === "zzz" && page.kind === "character");
    expect(page?.entries.map(entry => entry.id)).toEqual(["1011", "1061"]);
    const details = await catalog.roleDetails(page!.entries[0]!);
    expect(details?.overview).toMatchObject({ rarity: "A级", artwork: "gallery/zzz/IconRole01.webp" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test.each(["maze_extra", "maze_boss"] as const)("%s 缺少历史期、实装窗口、原详情或关联敌人时不发布", async pageId => {
  const work = await mkdtemp(join(tmpdir(), "lotus-atlas-hsr-rotation-refresh-"));
  const root = join(work, "atlas");
  const fiction = pageId === "maze_extra";
  const selection = `hsr/${pageId}` as const;
  const detailPath = fiction ? "story" : "boss";
  const original = {
    "2001": { id: 2001, zh: "历史期", begin: "", end: "", live_begin: "2024-01-01 04:00:00", live_end: "2024-02-01 04:00:00" },
    "2002": { id: 2002, zh: "当前期", begin: "", end: "", live_begin: "2024-02-01 04:00:00", live_end: "2024-03-01 04:00:00" },
  };
  let candidate = structuredClone(original);
  let live = "4.6";
  let detailMissing = false;
  let enemyMissing = false;
  const urls: string[] = [];
  const request = async (url: string) => {
    urls.push(url);
    if (url === `https://static.nanoka.cc/hsr/${live}/${pageId}.json`) return Response.json(candidate);
    const id = url.match(new RegExp(`/zh/${detailPath}/(200[12])[.]json$`))?.[1] as keyof typeof original | undefined;
    if (!id || !url.includes(`/${live}/`)) throw new Error(`不应请求 ${url}`);
    if (detailMissing && id === "2001") return missing();
    const retained = enemyMissing && id === "2001" ? 1002012 : 1002011;
    const level = {
      id: 1001, name: "首层", challenge: [],
      event_id_list1: [{ stage_id: 11, level: 60, hard_level_group: 1, monster_list: [{ monster0: 1002011 }] }],
      event_id_list2: [],
      ...(fiction ? { infinite_list1: { "201": { infinite_wave_id: 201, monster_group_id_list: [retained], elite_group: 1 } },
        infinite_list2: {} } : { boss_monster_id1: retained, boss_monster_id2: 1002011 }),
    };
    return Response.json({ id: Number(id), name: original[id].zh, level: [level], buff: {},
      ...(fiction ? { option: [], sub_option: [] } : { buff_list1: [], buff_list2: [], buff_list3: [] }) });
  };
  try {
    await acquireAtlasSource(root, [{ game: "hsr", pageId, version: live }], undefined, request);
    const manifest = async () => ({ hsr: { live, latest: "4.7.52", available: [live, "4.7.52"] } });
    const { commands } = createAtlasMaintenance(root, {
      manifest, request, updateConfig: { version_channel: "live", update_args: ["--pages", `hsr=${pageId}`] },
    });
    const owner = { atlasMaintenance: true } as const;
    live = "4.7";
    expect(await commands["#检查图鉴更新"]("", owner)).toContain("4.6 → 4.7，可准备候选");
    Reflect.deleteProperty(candidate, "2001");
    expect(await refreshAtlasSource(root, { selection, manifest, request })).toMatchObject({
      status: "invalid", issues: [expect.stringContaining("2001 缺少已有轮换资料")],
    });
    candidate = structuredClone(original);
    candidate["2001"].live_end = "2024-02-02 04:00:00";
    expect(await refreshAtlasSource(root, { selection, manifest, request })).toMatchObject({
      status: "invalid", issues: [expect.stringContaining("2001 与已有身份或实装窗口冲突")],
    });
    candidate = structuredClone(original);
    enemyMissing = true;
    expect(await refreshAtlasSource(root, { selection, manifest, request })).toMatchObject({
      status: "invalid", issues: [expect.stringContaining("2001 缺少已有楼层、战斗或敌人")],
    });
    enemyMissing = false;
    detailMissing = true;
    expect(await commands["#更新图鉴"]("", owner)).toContain("更新未完成");
    expect(await readAtlasSnapshotVersion(root)).toBeNull();
    detailMissing = false;
    urls.length = 0;
    expect(await commands["#更新图鉴"]("", owner)).toContain("已更新至 4.7");
    expect(await readAtlasSnapshotVersion(root)).toBe(1);
    expect(urls).toEqual([
      `https://static.nanoka.cc/hsr/4.7/${pageId}.json`,
      `https://static.nanoka.cc/hsr/4.7/zh/${detailPath}/2001.json`,
      `https://static.nanoka.cc/hsr/4.7/zh/${detailPath}/2002.json`,
    ]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});


test("星铁轮换校验兼容原导出历史名称标记和已记录的未命名末日预告", () => {
  const stage = { stage_id: 11, level: 60, hard_level_group: 1, monster_list: [{ monster0: 1002011 }] };
  const floor = { id: 1, group_name: "弦外之声(<unbreak>2.2</unbreak>)", name: "首层", challenge: [],
    event_id_list1: [stage], event_id_list2: [] };
  expect(mazeSourceOutline("maze", [floor], "弦外之声(2.2)", "1015")).toBeDefined();
  const preview = { id: 3024, name: null, buff: {}, buff_list1: [], buff_list2: [], buff_list3: [],
    level: [{ ...floor, name: null, boss_monster_id1: 1002011, boss_monster_id2: 1002011 }] };
  expect(mazeSourceOutline("maze_boss", preview, "3024", "3024")).toBeDefined();
  expect(mazeSourceOutline("maze_boss", { ...preview, id: 3025 }, "3025", "3025")).toBeUndefined();
});

test("绝区零敌人正式更新保留原图、变体和旧条目", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lotus-atlas-zzz-monster-"));
  const root = join(workspace, "atlas");
  try {
    const selection = "zzz/monster" as const;
    const old = "3.2";
    const live = "3.3";
    const preview = "3.4.4+20539349";
    const image = "UI/Sprite/A1DynamicLoad/BossCard/UnPacker/BossCardLv01/Monster_Test.png";
    const index = { zh: "样例敌人", rarity: 1, group: 201, icon: image };
    let failure: "old-entry" | "old-artwork" | "variant" | "identity" | undefined;
    const urls: string[] = [];
    const request = async (url: string) => {
      urls.push(url);
      if (url.endsWith("/monster.json")) return Response.json(failure === "old-entry" ? { "10001": index } : { "10000": index });
      const detail = /\/monster\/(\d+)\.json$/u.exec(url);
      if (detail) return Response.json({ id: failure === "identity" ? 9 : Number(detail[1]), name: index.zh, rarity: 1,
        group_id: 201, image_path: image, monster_id: 11096, desc: "正式原文。", monster_info: failure === "variant" ? {} : {
          "11096": { id: 11096, code_name: "Monster_Test", icon: "IconMonster_Test.png", stats: { hp: 1 } },
        } });
      if (url.endsWith("/IconMonster_Test.webp") || (failure === "old-artwork" && url.endsWith("/Monster_Test.webp"))) return missing();
      return new Response(new Uint8Array(webp));
    };
    await acquireAtlasSource(root, [{ game: "zzz", pageId: "monster", version: old }], undefined, request);
    urls.length = 0;
    const manifest = async () => ({ zzz: { live, latest: preview, available: [old, live, preview] } });
    for (const [mode, message] of [["old-entry", "缺少已有条目"], ["old-artwork", "缺少已下载图标"], ["variant", "缺少已有变体"]] as const) {
      failure = mode;
      const result = await refreshAtlasSource(root, { selection, manifest, request });
      expect(result).toMatchObject({ status: "invalid", issues: expect.arrayContaining([expect.stringContaining(message)]) });
      expect(await readAtlasSnapshotVersion(root)).toBeNull();
    }
    failure = "identity";
    await expect(refreshAtlasSource(root, { selection, manifest, request })).rejects.toThrow("身份或等级不符");
    expect(await readAtlasSnapshotVersion(root)).toBeNull();
    failure = undefined;
    const { commands } = createAtlasMaintenance(root, { updateConfig: { version_channel: "live", update_args: ["--page", "zzz=monster"] }, manifest, request });
    expect(await commands["#检查图鉴更新"]("", { atlasMaintenance: true })).toContain(`${old} → ${live}`);
    expect(await commands["#更新图鉴"]("", { atlasMaintenance: true })).toContain(`绝区零敌人 · 已更新至 ${live}`);
    expect(await readAtlasSnapshotVersion(root)).toBe(1);
    expect(urls.some(url => url.includes(preview))).toBe(false);
    const atlas = createAtlasRuntimeCatalog(root);
    const entry = (await atlas.read()).pages.find(page => page.game === "zzz" && page.kind === "monster")?.entries[0];
    expect(await atlas.monsterDetails(entry!)).toMatchObject({ description: "正式原文。", artwork: "gallery/zzz/Monster_Test.webp" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("异相仲裁由正式索引更新，并保留已有期次、窗口、骑士与两类王棋资料", async () => {
  const work = await mkdtemp(join(tmpdir(), "lotus-atlas-hsr-peak-refresh-"));
  const root = join(work, "atlas");
  const selection = "hsr/maze_peak";
  const pageId = "maze_peak";
  const original = {
    "1": { zh: "历史期", live_begin: "2026-07-01 04:00:00", live_end: "2026-08-01 04:00:00" },
    "8": { zh: "<unbreak>4.4</unbreak>异相仲裁" },
  };
  const official = { ...original, "8": { zh: "尘世卷中" } };
  let candidate: Partial<typeof original> = original;
  let live = "4.6";
  let failure: "wave" | "elite" | "knight" | "boss" | "extreme" | undefined;
  const urls: string[] = [];
  const request = async (url: string) => {
    urls.push(url);
    if (url === `https://static.nanoka.cc/hsr/${live}/maze_peak.json`) return Response.json(candidate);
    const id = url.match(/\/zh\/peak\/(1|8)[.]json$/u)?.[1] as keyof typeof original | undefined;
    if (!id || !url.includes(`/${live}/`) || !candidate[id]) throw new Error(`不应请求 ${url}`);
    const row = (suffix: number, name: string, stage_name: number) => {
      const stage_id = Number(id) * 1_000 + suffix;
      return { id: Number(id) * 100 + suffix, name, tag_list: [],
        event_id_list: [{ stage_id, stage_name, level: 95, hard_level_group: 3, monster_list: [{ monster0: 1002011 }] }],
        infinite_list: { [stage_id * 10 + 1]: { infinite_wave_id: stage_id * 10 + 1,
          elite_group: failure === "elite" ? 346 : suffix === 1 ? 169 : 345, monster_group_id_list: [failure === "wave" ? 1002012 : 1002011] } } };
    };
    const boss_level = row(4, "将杀王棋", 40);
    const { id: _, name: __, ...extreme } = row(5, "", failure === "extreme" ? 50 : 40);
    const knights = [row(1, "骑士（一）", 10), row(2, "骑士（二）", 20), row(3, "骑士（三）", 30)];
    return Response.json({ id: Number(id), name: candidate[id].zh, pre_level: failure === "knight" ? knights.slice(1) : knights,
      boss_level: failure === "boss" ? {} : boss_level, boss_config: { ...extreme, hard_name: "将杀王棋•绝境", buff_list: [] } });
  };
  const manifest = async () => ({ hsr: { live, latest: "4.7.52", available: [live, "4.7.52"] } });
  const refresh = () => refreshAtlasSource(root, { selection, manifest, request });
  try {
    await acquireAtlasSource(root, [{ game: "hsr", pageId, version: live }], undefined, request);
    for (const [pageId, EliteGroup] of [["EliteGroup", 169], ["InfiniteEliteGroup", 345]] as const) {
      const groupSource = join(work, pageId);
      const groupPlan = [{ game: "hsr", pageId, version: "4.7" }] as const;
      await acquireAtlasSource(groupSource, groupPlan, undefined, async () => Response.json([{
        EliteGroup, AttackRatio: 1, DefenceRatio: 1, HPRatio: 1, SpeedRatio: 1, StanceRatio: 1,
      }]));
      expect((await applyAtlasCandidate(root, groupSource, groupPlan)).status).toBe("published");
    }
    const { commands } = createAtlasMaintenance(root, {
      manifest, request, updateConfig: { version_channel: "live", update_args: ["--pages", "hsr=maze_peak"] },
    });
    const owner = { atlasMaintenance: true } as const;
    live = "4.7";
    expect(await commands["#检查图鉴更新"]("", owner)).toContain("4.6 → 4.7，可准备候选");
    candidate = { "8": official["8"] };
    expect(await refresh()).toMatchObject({ status: "invalid", issues: [expect.stringContaining("1 缺少已有轮换资料")] });
    candidate = { ...official, "1": { ...official["1"], live_end: "2026-08-02 04:00:00" } };
    expect(await refresh()).toMatchObject({ status: "invalid", issues: [expect.stringContaining("1 与已有身份或实装窗口冲突")] });
    candidate = official;
    failure = "wave";
    expect(await refresh()).toMatchObject({ status: "invalid", issues: expect.arrayContaining([expect.stringContaining("缺少已有楼层、战斗或敌人")]) });
    failure = "elite";
    expect(await refresh()).toMatchObject({ status: "invalid", issues: expect.arrayContaining([
      expect.stringContaining("无法关联同版本星铁精英组或星铁无限精英组 346"),
    ]) });
    for (const variant of ["knight", "boss", "extreme"] as const) {
      failure = variant;
      expect(await commands["#更新图鉴"]("", owner)).toContain("更新未完成");
      expect(await readAtlasSnapshotVersion(root)).toBe(2);
    }
    failure = undefined;
    urls.length = 0;
    expect(await commands["#更新图鉴"]("", owner)).toContain("异相仲裁 · 已更新至 4.7");
    expect(await readAtlasSnapshotVersion(root)).toBe(3);
    expect(urls).toEqual([
      "https://static.nanoka.cc/hsr/4.7/maze_peak.json",
      "https://static.nanoka.cc/hsr/4.7/zh/peak/1.json",
      "https://static.nanoka.cc/hsr/4.7/zh/peak/8.json",
    ]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
