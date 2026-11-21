import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtlasMaintenance } from "./maintenance.ts";
import { validateAtlasCandidate } from "./validate-candidate.ts";

test("原神切到正式版时，七圣和武器同发，缺任一整组保留原快照", async () => {
  const work = await mkdtemp(join(tmpdir(), "lotus-atlas-version-selection-"));
  const root = join(work, "atlas");
  const active = join(root, "snapshots", "1", "data");
  const exported = join(work, "exported");
  const source = { gi: { live: "7.2", latest: "7.2.52", available: ["7.2", "7.2.52"] } };
  async function save(data: string, pages: readonly { id: string; version: string; record: string; name: string }[]) {
    await mkdir(join(data, "items"), { recursive: true });
    const byPage: Record<string, unknown> = {};
    for (const { id, version, record, name } of pages) {
      const path = "items/" + id + ".json";
      byPage[id] = { id, version, sampled: false, recordCount: 1, totalRecordCount: 1,
        records: { [record]: { id: record, name, path, hasDetail: false } } };
      await Bun.write(join(data, path), JSON.stringify({
        meta: { gameId: "gi", pageId: id, version, locale: "zh", recordId: record, name, hasDetail: false },
        content: { list: { zh: name }, detail: null },
      }));
    }
    await Bun.write(join(data, "map.json"), JSON.stringify({ games: { gi: { locales: { zh: { pages: byPage } } } } }));
  }
  try {
    await save(active, [{ id: "weapon", version: "7.2.52", record: "11552", name: "预览武器" },
      { id: "gcg", version: "7.2.52", record: "81001", name: "预览卡牌" },
      { id: "character", version: "7.2", record: "10000037", name: "甘雨" }]);
    await symlink("snapshots/1/data", join(root, "current"));
    await save(join(exported, "data"), [{ id: "weapon", version: "7.2", record: "11501", name: "正式武器" }]);
    let cardsAvailable = false;
    let exportAvailable = true;
    let downloads = 0;
    const requests: string[] = [];
    const job = createAtlasMaintenance(root, {
      updateConfig: { version_channel: "live", update_args: ["--game", "gi", "--pages", "gi=weapon,gcg"] },
      manifest: async () => source,
      async downloadVersion(workspace, target, versions, consume, _signal, _request, scope, baseline) {
        downloads++;
        expect(workspace).toBe(join(work, "atlas-download"));
        expect(target).toBe(root);
        expect(baseline).toBe(active);
        expect(versions).toEqual({ gi: "7.2" });
        expect(scope?.map(item => item.pageId)).toEqual(["weapon"]);
        if (!exportAvailable) throw new Error("原导出不可用");
        return consume(exported, [{ game: "gi", pageId: "weapon", version: "7.2", recordCount: 1 }]);
      },
      async request(input, options) {
        const url = new URL(input);
        expect(url.origin).toBe("https://static.nanoka.cc");
        expect(options.credentials).toBe("omit");
        requests.push(url.pathname);
        const icon = "UI_Gcg_CardFace_Char_Avatar_Ayaka";
        if (!cardsAvailable) return new Response(null, { status: 404 });
        if (url.pathname === "/gi/7.2/gcg.json") return Response.json({
          "1105": { zh: "神里绫华", type: "Character", hp: 10, icon },
        });
        if (url.pathname === "/gi/7.2/zh/gcg/1105.json") return Response.json({
          name: "神里绫华", type: "Character", icon, tag: ["冰元素"], hp: 10, talent: {},
        });
        if (url.pathname.startsWith("/assets/gi/")) return new Response(null, { status: 404 });
        if (url.pathname.startsWith("/gi/7.2/zh/gcg/")) return Response.json({ "1": { name: "同版引用" } });
        throw new Error(url.pathname);
      },
    });
    const owner = { atlasMaintenance: true } as const;
    const unchanged = async () => {
      expect(await readlink(join(root, "current"))).toBe("snapshots/1/data");
      expect(await readdir(join(root, "snapshots"))).toEqual(["1"]);
    };
    expect(await job.commands["#检查图鉴更新"]("", owner)).toContain("七圣召唤 · 7.2.52 → 7.2");
    expect(downloads).toBe(0);
    await unchanged();
    exportAvailable = false;
    expect(await job.commands["#更新图鉴"]("", owner)).toContain("所选 2 类未完成更新");
    expect(requests).toHaveLength(0);
    await unchanged();
    exportAvailable = true;
    expect(await job.atlasSchedule.version.run()).toContain("所选 2 类未完成更新");
    await unchanged();
    cardsAvailable = true;
    expect(await job.atlasSchedule.version.run()).toContain("所选 2 类已核对并发布至快照 2");
    expect(await readlink(join(root, "current"))).toBe("snapshots/2/data");
    expect((await readdir(join(root, "snapshots"))).sort()).toEqual(["1", "2"]);
    const now = await validateAtlasCandidate(join(root, "current"));
    expect(now.ok).toBeTrue();
    expect(now.pages.map(({ pageId, version }) => [pageId, version]).sort()).toEqual([
      ["character", "7.2"], ["gcg", "7.2"], ["weapon", "7.2"],
    ]);
    expect(await Bun.file(join(root, "current", "items", "character.json")).text())
      .toBe(await Bun.file(join(active, "items", "character.json")).text());
    const before = requests.length;
    expect(await job.atlasSchedule.version.run()).toContain("七圣召唤 · 已是同一版本 7.2");
    expect(requests).toHaveLength(before);
    expect(downloads).toBe(3);
    expect((await readdir(work)).some(name => name.startsWith(".atlas-version-cards-"))).toBeFalse();
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
