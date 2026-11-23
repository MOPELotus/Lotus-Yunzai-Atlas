import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyAtlasSourcePages } from "./legacy-source-profile.ts";
import { atlasMaintenanceAliases, createAtlasMaintenance } from "./maintenance.ts";
import { validateAtlasCandidate } from "./validate-candidate.ts";

const version = "7.2";
const release = { live: version, latest: version, available: [version] };
const manifest = { gi: release, hsr: release, zzz: release };
const config = { version_channel: "latest", update_args: ["--page", "gi=weapon"] };
const pageList = legacyAtlasSourcePages.map(({ game, pageId }) => ({ game, pageId, version, recordCount: 1 }));

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-atlas-empty-schedule-"));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function exportAll(directory: string) {
  const data = join(directory, "data");
  const games = Object.fromEntries(["gi", "hsr", "zzz"].map((game) => [game, { locales: { zh: { pages: {} } } }]));
  for (const { game, pageId } of pageList) {
    const relative = `items/${game}/${pageId}/1.json`;
    const pages: Record<string, unknown> = games[game]!.locales.zh.pages;
    pages[pageId] = { id: pageId, version, sampled: false, recordCount: 1, totalRecordCount: 1,
      records: { "1": { id: "1", name: "原资料", path: relative, hasDetail: false } } };
    await Bun.write(join(data, relative), JSON.stringify({
      meta: { gameId: game, pageId, version, locale: "zh", recordId: "1", name: "原资料", hasDetail: false },
      content: { list: {}, detail: null },
    }));
  }
  await Bun.write(join(data, "map.json"), JSON.stringify({ games }));
}

async function cards(input: string, init: RequestInit) {
  const url = new URL(input);
  expect(url.origin).toBe("https://static.nanoka.cc");
  expect(init.credentials).toBe("omit");
  const icon = "UI_Gcg_CardFace_Char_Avatar_Ayaka";
  if (url.pathname === "/gi/7.2/gcg.json") {
    return Response.json({ "1105": { zh: "神里绫华", type: "Character", hp: 10, icon } });
  }
  if (url.pathname === "/gi/7.2/zh/gcg/1105.json") {
    return Response.json({ name: "神里绫华", type: "Character", icon, tag: ["冰元素"], hp: 10, talent: {} });
  }
  if (url.pathname.startsWith("/assets/gi/")) return new Response(null, { status: 404 });
  if (url.pathname.startsWith("/gi/7.2/zh/gcg/")) return Response.json({ "1": { name: "同版引用" } });
  throw new Error(url.pathname);
}

test("缺资料的版本定时复用完整首装，发布三游戏及七圣后正常回到增量", () => fixture(async (directory) => {
  const root = join(directory, "data/atlas");
  const source = join(directory, "export");
  await exportAll(source);
  await mkdir(join(root, "theme"), { recursive: true });
  await Bun.write(join(root, "theme/original.png"), "fixture theme");
  let checks = 0, downloads = 0, requests = 0;
  const job = createAtlasMaintenance(root, {
    updateConfig: config,
    manifest: async () => { checks++; return manifest; },
    async downloadVersion(_work, target, versions, consume, _signal, _request, scope, baseline) {
      downloads++;
      expect(target).toBe(root);
      expect(versions).toEqual({ gi: version, hsr: version, zzz: version });
      expect(scope).toBeUndefined();
      expect(baseline).toBeUndefined();
      return consume(source, pageList);
    },
    async request(url, init) { requests++; return cards(url, init); },
  });
  expect(job.atlasSchedule.challenge.cron).toBeDefined();
  expect(await job.atlasSchedule.challenge.run()).toContain("未初始化");
  expect(checks).toBe(0);
  expect(await job.atlasSchedule.version.run()).toContain("自动初始化完成，已发布第 1 版");
  expect(await readlink(join(root, "current"))).toBe("snapshots/1/data");
  expect(await Bun.file(join(root, "theme/original.png")).text()).toBe("fixture theme");
  const verified = await validateAtlasCandidate(join(root, "current"), [...pageList, { game: "gi", pageId: "gcg" }]);
  expect(verified.ok).toBeTrue();
  expect(verified.pages).toHaveLength(pageList.length + 1);
  const first = requests;
  expect(first).toBeGreaterThan(0);
  expect(await job.atlasSchedule.version.run()).toContain("本地所选 1 类版本均为目标版本");
  expect(checks).toBe(2);
  expect(downloads).toBe(1);
  expect(requests).toBe(first);
  expect(await readdir(join(root, "snapshots"))).toEqual(["1"]);
}));

test("主人普通更新在定时停用时仍可按已选渠道首装，检查只读", () => fixture(async (directory) => {
  const root = join(directory, "data/atlas");
  const source = join(directory, "export");
  await exportAll(source);
  let checks = 0, downloads = 0;
  const job = createAtlasMaintenance(root, {
    updateConfig: { ...config, auto_update: { enable: false } },
    manifest: async () => { checks++; return manifest; },
    async downloadVersion(_work, _root, _versions, consume) { downloads++; return consume(source, pageList); },
    request: cards,
  });
  const owner = { atlasMaintenance: true } as const;
  const alias = atlasMaintenanceAliases["#图鉴更新"];
  expect(alias).toBe("#更新图鉴");
  expect(await job.commands["#更新图鉴"]("", {})).toContain("只有 bot 主人");
  expect(await job.commands["#更新图鉴"]("", { ...owner, isDelegated: true })).toContain("只有 bot 主人");
  expect(await job.commands["#更新图鉴"]("误传参数", owner)).toContain("请直接发送");
  expect(await job.atlasSchedule.version.run()).toContain("未启用");
  expect(await job.commands["#检查图鉴更新"]("", owner)).toContain("未初始化");
  expect(checks).toBe(0);
  expect(await job.commands["#更新图鉴"]("", owner)).toBe("图鉴初始化完成，已发布第 1 版。");
  const data = join(root, "current");
  expect((await validateAtlasCandidate(data, [...pageList, { game: "gi", pageId: "gcg" }])).ok).toBeTrue();
  expect(await job.commands["#更新图鉴"]("", owner)).toContain("本地所选 1 类版本均为目标版本");
  expect(downloads).toBe(1);
  expect(await readdir(join(root, "snapshots"))).toEqual(["1"]);
}));

test("关闭图鉴同步时定时和主人首装只保存候选，重新启用后按正常入口发布", () => fixture(async (directory) => {
  const root = join(directory, "data/atlas");
  const source = join(directory, "export");
  const owner = { atlasMaintenance: true } as const;
  await exportAll(source);
  const job = (sync_after_update: boolean) => createAtlasMaintenance(root, {
    updateConfig: { ...config, sync_after_update },
    manifest: async () => manifest,
    async downloadVersion(_work, _root, _versions, consume) { return consume(source, pageList); },
    request: cards,
  });
  const staged = job(false);
  const candidate = join(root, ".prepared");
  expect(await staged.commands["#检查图鉴更新"]("", owner)).toContain("未初始化");
  expect(await staged.atlasSchedule.version.run()).toContain("自动初始化候选已保存");
  await expect(readlink(join(root, "current"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readlink(join(candidate, "current"))).toBe("snapshots/1/data");
  expect((await validateAtlasCandidate(join(candidate, "current"))).pages).toHaveLength(30);

  expect(await staged.commands["#更新图鉴"]("", owner)).toContain("尚未发布至现用目录");
  await expect(readlink(join(root, "current"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readlink(join(candidate, "current"))).toBe("snapshots/2/data");
  expect(await readdir(join(candidate, "snapshots"))).toEqual(["2"]);
  expect(await job(true).commands["#更新图鉴"]("", owner)).toBe("图鉴初始化完成，已发布第 1 版。");
  expect(await readlink(join(root, "current"))).toBe("snapshots/1/data");
  expect((await validateAtlasCandidate(join(root, "current"))).ok).toBeTrue();
}));

test("主人全量更新对齐选定渠道，工作期间拒绝其他写操作且不能降级现用资料", () => fixture(async (directory) => {
  const root = join(directory, "data/atlas");
  const source = join(directory, "export");
  await exportAll(source);
  const owner = { atlasMaintenance: true } as const;
  const initial = createAtlasMaintenance(root, {
    updateConfig: config,
    manifest: async () => manifest,
    async downloadVersion(_work, _root, _versions, consume) { return consume(source, pageList); },
    request: cards,
  });
  await initial.commands["#更新图鉴"]("", owner);

  const observed = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const older = { live: "7.1", latest: version, available: ["7.1", version] };
  let reads = 0, downloads = 0;
  const update = createAtlasMaintenance(root, {
    updateConfig: { ...config, version_channel: "live" },
    async manifest() { reads++; observed.resolve(); await proceed.promise; return { gi: older, hsr: older, zzz: older }; },
    async request() { downloads++; throw new Error("降版不能开始取源"); },
  });
  expect(atlasMaintenanceAliases["#图鉴全量更新"]).toBe("#全量更新图鉴");
  expect(await update.commands["#全量更新图鉴"]("", {})).toContain("只有 bot 主人");
  expect(await update.commands["#全量更新图鉴"]("", { ...owner, isDelegated: true })).toContain("只有 bot 主人");
  expect(reads).toBe(0);
  const refreshing = update.commands["#全量更新图鉴"]("", owner);
  try {
    await observed.promise;
    expect(await update.commands["#更新图鉴"]("", owner)).toContain("已有图鉴更新正在进行");
    expect(await update.commands["#重置图鉴"]("", owner)).toContain("已有图鉴更新正在进行");
  } finally {
    proceed.resolve();
  }
  expect(await refreshing).toContain("低于现用版本");
  expect(downloads).toBe(0);
  expect(await readlink(join(root, "current"))).toBe("snapshots/1/data");
  expect(await readdir(join(root, "snapshots"))).toEqual(["1"]);
}));

test("受管空根外的旧数据和显式禁用保持零取源", () => fixture(async (directory) => {
  const cases = ["disabled", "no-channel", "no-schedule", "external", "old", "dangling", "invalid-pointer", "reset", "partial-flat", "archive", "symlink", "damaged"];
  for (const name of cases) {
    const checkout = join(directory, name);
    const root = join(checkout, "data/atlas");
    if (["old", "dangling", "invalid-pointer", "reset", "partial-flat", "archive", "symlink", "damaged"].includes(name)) {
      await mkdir(join(checkout, "data"), { recursive: true });
      if (name === "symlink") {
        const actual = join(checkout, "other");
        await mkdir(actual);
        await symlink(actual, root);
      } else await mkdir(root);
    }
    if (name === "old") await Bun.write(join(checkout, "plugins/Lotus-Plugin/data/atlas/data/map.json"), "{}");
    if (name === "dangling") await symlink("snapshots/1/data", join(root, "current"));
    if (name === "invalid-pointer") await symlink("../archive", join(root, "current"));
    if (name === "reset") await symlink(".atlas-reset", join(root, "current"));
    if (name === "partial-flat") await mkdir(join(root, "data"));
    if (name === "archive") await mkdir(join(root, "snapshots/1/data"), { recursive: true });
    if (name === "damaged") {
      await Bun.write(join(root, "snapshots/1/data/map.json"), "{corrupt");
      await symlink("snapshots/1/data", join(root, "current"));
    }
    let checks = 0;
    const job = createAtlasMaintenance(root, {
      updateConfig: name === "no-channel" ? { update_args: config.update_args } : {
        ...config, auto_update: { enable: name !== "no-schedule", run_on_missing_data: name !== "disabled" },
      },
      dataOverride: name === "external" ? join(checkout, "external") : undefined,
      manifest: async () => { checks++; return manifest; },
      async downloadVersion() { throw new Error("不得触发首装"); },
    });
    await job.atlasSchedule.version.run();
    await job.commands["#检查图鉴更新"]("", { atlasMaintenance: true });
    if (name !== "no-schedule") await job.commands["#更新图鉴"]("", { atlasMaintenance: true });
    expect([name, checks]).toEqual([name, 0]);
    if (name === "reset") expect(await readlink(join(root, "current"))).toBe(".atlas-reset");
    if (name === "damaged") expect(await Bun.file(join(root, "snapshots/1/data/map.json")).text()).toBe("{corrupt");
  }
}));

test("下载期间出现新资料或重置指针时，在同一发布锁内拒绝切换", () => fixture(async (directory) => {
  const source = join(directory, "export");
  await exportAll(source);
  for (const reset of [false, true]) {
    const root = join(directory, String(reset), "data/atlas");
    const job = createAtlasMaintenance(root, {
      updateConfig: config,
      manifest: async () => manifest,
      async downloadVersion(_work, _root, _versions, consume) {
        if (reset) await symlink(".atlas-reset", join(root, "current"));
        else await Bun.write(join(root, "operator.txt"), "operator changed the root");
        return consume(source, pageList);
      },
      request: cards,
    });
    expect(await job.atlasSchedule.version.run()).toContain("未自动初始化");
    expect(await Bun.file(join(root, "current/map.json")).exists()).toBeFalse();
    if (reset) expect(await readlink(join(root, "current"))).toBe(".atlas-reset");
    else {
      expect(await Bun.file(join(root, "operator.txt")).text()).toBe("operator changed the root");
      expect((await readdir(root)).includes("current")).toBeFalse();
    }
  }
}));

test("来源缺一个首装分类时保留空根和下载结果，下一次能完整安装", () => fixture(async (directory) => {
  const root = join(directory, "data/atlas");
  const source = join(directory, "export");
  await exportAll(source);
  let partial = true, requests = 0;
  const job = createAtlasMaintenance(root, {
    updateConfig: config,
    manifest: async () => manifest,
    async downloadVersion(_work, _root, _versions, consume) {
      return consume(source, partial ? pageList.slice(1) : pageList);
    },
    async request(url, init) { requests++; return cards(url, init); },
  });
  expect(await job.atlasSchedule.version.run()).toContain("未自动初始化");
  expect(requests).toBe(0);
  expect(await readdir(root)).toEqual([]);
  partial = false;
  expect(await job.atlasSchedule.version.run()).toContain("自动初始化完成");
  expect(await readlink(join(root, "current"))).toBe("snapshots/1/data");
}));
