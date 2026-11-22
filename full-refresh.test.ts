import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyAtlasSourcePages } from "./legacy-source-profile.ts";
import { createAtlasMaintenance } from "./maintenance.ts";
import { resetAtlasSnapshot } from "./publish-candidate.ts";
import { validateAtlasCandidate } from "./validate-candidate.ts";

test("主人全量命令重取同版详情、跳过无变化发布，并保留退化前的完整快照", async () => {
  const work = await mkdtemp(join(tmpdir(), "lotus-atlas-full-refresh-"));
  try {
    const root = join(work, "atlas");
    const version = "7.2";
    const release = { live: version, latest: version, available: [version] };
    const indexPaths = new Map(legacyAtlasSourcePages.map(page =>
      [`/${page.game}/${version}/${page.indexPath.split("/").slice(3).join("/")}`, page]));
    const groupStats = { AttackRatio: 1, DefenceRatio: 1, HPRatio: 1, SpeedRatio: 1, StanceRatio: 1 };
    const name = "原站测试条目";
    const stage = { stage_id: 111, stage_name: 10, level: 90, hard_level_group: 1, monster_list: [{ monster0: 1002011 }] };
    const normalFloor = { id: 111, group_name: name, name: "第一层", challenge: [], event_id_list1: [stage], event_id_list2: [stage],
      infinite_list1: {}, infinite_list2: {}, boss_monster_id1: 1002011, boss_monster_id2: 1002011 };
    const peakFloor = (number: number) => {
      const stageId = 100 + number;
      const wave = stageId * 10 + 1;
      return { id: stageId, name: "王棋", tag_list: [], event_id_list: [{ ...stage, stage_id: stageId }],
        infinite_list: { [wave]: { infinite_wave_id: wave, elite_group: 1, monster_group_id_list: [1002011] } } };
    };
    const rotations = {
      maze: [normalFloor],
      story: { id: 1, name, level: [normalFloor], buff: {}, option: [], sub_option: [] },
      boss: { id: 1, name, level: [normalFloor], buff: {}, buff_list1: [], buff_list2: [], buff_list3: [] },
      peak: { id: 1, name, pre_level: [peakFloor(1), peakFloor(2), peakFloor(3)],
        boss_level: peakFloor(4), boss_config: { ...peakFloor(5), hard_name: "绝境", buff_list: [] } },
    };
    let detail: string | undefined = "旧详情";
    let concurrentReset = false;
    const urls: string[] = [];
    const job = createAtlasMaintenance(root, {
      updateConfig: { version_channel: "latest", update_args: ["--pages", "gi=weapon"] },
      manifest: async () => ({ gi: release, hsr: release, zzz: release }),
      async request(input) {
        const url = new URL(input);
        expect(url.origin).toBe("https://static.nanoka.cc");
        const path = url.pathname;
        urls.push(path);
        const page = indexPaths.get(path);
        if (page?.indexShape === "array") {
          return Response.json([page.pageId === "HardLevelGroup"
            ? { ...groupStats, HardLevelGroup: 1, Level: 90, CombatPowerList: [0, 0, 0, 0] }
            : { ...groupStats, EliteGroup: 1 }]);
        }
        if (page?.pageId === "achievement/achievement") {
          return Response.json(page.game === "zzz"
            ? { category: { "1": { name, group: { "1": { name, sort: 1 } } } },
              achievement: { "101": { name, group: 1 } }, mutual_type: { "1": {} } }
            : { "1": { name, id: 1, list: [{ id: 101, name }] } });
        }
        if (page) return Response.json({ "1": { zh: name, id: page.pageId === "maze" ? "1" : 1 } });
        const icon = "UI_Gcg_CardFace_Char_Avatar_Ayaka";
        if (path === `/gi/${version}/gcg.json`) {
          return Response.json({ "1105": { zh: "神里绫华", type: "Character", hp: 10, icon } });
        }
        if (path === `/gi/${version}/zh/gcg/1105.json`) {
          return Response.json({ name: "神里绫华", type: "Character", icon, tag: ["冰元素"], hp: 10, talent: {} });
        }
        if (path.startsWith(`/gi/${version}/zh/gcg/`)) return Response.json({ "1": { name: "同版引用" } });
        if (path === `/gi/${version}/zh/weapon/1.json` && detail !== undefined) {
          if (concurrentReset) await resetAtlasSnapshot(root);
          return Response.json({ name, desc: detail });
        }
        const rotation = new RegExp(`^/hsr/${version.replace(".", "[.]")}/zh/(maze|story|boss|peak)/1[.]json$`, "u").exec(path)?.[1];
        if (rotation && Object.hasOwn(rotations, rotation)) return Response.json(rotations[rotation as keyof typeof rotations]);
        return new Response(null, { status: 404 });
      },
    });
    const owner = { atlasMaintenance: true } as const;
    const update = () => job.commands["#全量更新图鉴"]("", owner);
    const pointer = () => readlink(join(root, "current"));
    const data = join(root, "current");
    const weapon = join(data, "items/简体中文/gi/weapon/1.json");
    await mkdir(root);
    expect(await update()).toContain("初始化完成");
    expect(await pointer()).toBe("snapshots/1/data");
    expect((await validateAtlasCandidate(data)).pages).toHaveLength(30);
    expect((await Bun.file(weapon).json()).content.detail.desc).toBe("旧详情");
    urls.length = 0;
    expect(await update()).toContain("和现用资料一致");
    expect(await pointer()).toBe("snapshots/1/data");
    expect(urls.filter(url => indexPaths.has(url))).toHaveLength(29);
    expect(urls).toContain(`/gi/${version}/zh/weapon/1.json`);
    expect(urls).toContain(`/gi/${version}/zh/gcg/1105.json`);
    detail = "同版新详情";
    expect(await update()).toContain("发布至快照 2");
    expect(await pointer()).toBe("snapshots/2/data");
    expect((await Bun.file(weapon).json()).content.detail.desc).toBe("同版新详情");
    detail = undefined;
    expect(await update()).toContain("保留现用资料");
    expect(await pointer()).toBe("snapshots/2/data");
    expect((await Bun.file(weapon).json()).content.detail.desc).toBe("同版新详情");
    detail = "准备发布时现用指针发生变化";
    concurrentReset = true;
    expect(await update()).toContain("本次候选未发布");
    expect(await pointer()).toBe(".atlas-reset");
    expect((await Bun.file(join(root, "snapshots/2/data/items/简体中文/gi/weapon/1.json")).json()).content.detail.desc)
      .toBe("同版新详情");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
