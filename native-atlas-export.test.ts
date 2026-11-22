import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadAtlasVersion, redownloadAtlasVersion } from "./download-legacy-atlas.ts";
import { copyAtlasSelectedPages } from "./assemble-candidate.ts";
import type { AtlasSourceFetch } from "./source-transport.ts";

const webp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");

test("原 Bun 下载能从空目录续跑，复用已验证的同版详情和原图", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-native-atlas-"));
  try {
    const atlas = join(root, "atlas");
    const workspace = join(root, "workspace");
    const seed = join(root, "seed");
    await mkdir(atlas);
    const urls: string[] = [];
    let restored = false;
    const request: AtlasSourceFetch = async (url, options) => {
      const { origin, pathname } = new URL(url);
      expect(origin).toBe("https://static.nanoka.cc");
      expect(options.credentials).toBe("omit");
      expect(options.redirect).toBe("error");
      expect(new Headers(options.headers).has("Cookie")).toBeFalse();
      urls.push(pathname);
      if (pathname === "/gi/7.2/weapon.json") return Response.json({
        "11401": { zh: "西风剑", icon: "UI_EquipIcon_Sword_Zephyrus", rank: 4 },
        "11501": { zh: "风鹰剑", icon: "UI_EquipIcon_Sword_Falcon", rank: 5 },
      });
      if (pathname === "/gi/7.2/zh/weapon/11401.json") return Response.json({
        name: "西风剑", icon: "UI_EquipIcon_Sword_Zephyrus",
      });
      if (pathname === "/gi/7.2/zh/weapon/11501.json") return restored ? Response.json({
        name: "风鹰剑", icon: "UI_EquipIcon_Sword_Falcon",
      }) : new Response(null, { status: 503 });
      if (pathname === "/assets/gi/UI_EquipIcon_Sword_Zephyrus.webp" ||
          pathname === "/assets/gi/UI_EquipIcon_Sword_Falcon.webp") return new Response(new Uint8Array(webp));
      throw new Error(pathname);
    };
    const download = (copy: boolean) => downloadAtlasVersion(workspace, atlas, { gi: "7.2" }, async (source, pages) => {
      if (copy) await copyAtlasSelectedPages(source, seed, pages);
      const data = await Bun.file(join(source, "data", "map.json")).json();
      const entries = data.games.gi.locales.zh.pages.weapon.records;
      expect(entries["11401"].name).toBe("西风剑");
      expect(entries["11501"].rarity).toBe("五星");
      return pages;
    }, undefined, request, [{ game: "gi", pageId: "weapon" }], copy ? undefined : join(seed, "data"));
    await expect(download(true)).rejects.toThrow("HTTP 503");
    expect(await Bun.file(join(atlas, "current")).exists()).toBeFalse();
    expect(urls).toContain("/assets/gi/UI_EquipIcon_Sword_Zephyrus.webp");
    const failedAt = urls.length;
    restored = true;
    expect(await download(true)).toEqual([{ game: "gi", pageId: "weapon", version: "7.2", recordCount: 2 }]);
    expect(urls.slice(failedAt)).toEqual(["/gi/7.2/weapon.json", "/gi/7.2/zh/weapon/11501.json",
      "/assets/gi/UI_EquipIcon_Sword_Falcon.webp"]);
    const successfulAt = urls.length;
    expect(await download(false)).toHaveLength(1);
    expect(urls.slice(successfulAt)).toEqual(["/gi/7.2/weapon.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("首次与同版增量保留索引及详情大整数的原表示，稳定复用不会重请求详情", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-native-atlas-precision-"));
  try {
    const target = join(root, "target");
    const workspace = join(root, "workspace");
    await mkdir(target);
    const scopes = [{ game: "hsr", pageId: "maze_boss" }] as const;
    const indexPath = "/hsr/4.7.52/maze_boss.json";
    const detailPath = "/hsr/4.7.52/zh/boss/3022.json";
    const recordPath = "data/items/简体中文/hsr/maze_boss/3022.json";
    const first = "3513447881416968543";
    const next = "3513447881416968544";
    const calls: string[] = [];
    let token = first;
    expect(Number(first)).toBe(Number(next));
    const indexRow = () => `{"zh":"验证条目","stage_name":${token},"ratio":1.2500}`;
    const detail = () => `{"name":"原正文","stages":[{"stage_name":${token},"desc":"原文字"}],"factor":-0}`;
    const request: AtlasSourceFetch = async (url) => {
      const { pathname } = new URL(url);
      calls.push(pathname);
      if (pathname === indexPath) return new Response(`{"3022":${indexRow()}}`);
      if (pathname === detailPath) return new Response(detail());
      throw new Error(pathname);
    };
    function download(baseline?: string, save?: string) {
      return downloadAtlasVersion(workspace, target, { hsr: "4.7.52" }, async (source, pages) => {
        const raw = await Bun.file(join(source, recordPath)).text();
        expect(raw).toContain(`"list":${indexRow()}`);
        expect(raw).toContain(`"detail":${detail()}`);
        expect(JSON.parse(raw).content.detail.stages[0].desc).toBe("原文字");
        if (save) await copyAtlasSelectedPages(source, save, pages);
      }, undefined, request, scopes, baseline);
    }
    const firstSeed = join(root, "first-seed");
    await download(undefined, firstSeed);
    expect(calls.splice(0)).toEqual([indexPath, detailPath]);

    await download(join(firstSeed, "data"));
    expect(calls.splice(0)).toEqual([indexPath]);

    token = next;
    await download(join(firstSeed, "data"));
    expect(calls).toEqual([indexPath, detailPath]);
    expect(await Bun.file(join(firstSeed, recordPath)).text()).toContain(first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("显式重取同版索引和明细，已验原图复用而常规缓存保持", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-native-atlas-redownload-"));
  try {
    const target = join(root, "target");
    const work = join(root, "work");
    const archive = join(root, "archive");
    const cachedExport = join(work, "backend");
    await mkdir(target);
    const selection = [{ game: "gi", pageId: "weapon" }] as const;
    const versions = { gi: "7.2" };
    const index = "/gi/7.2/weapon.json";
    const detail = "/gi/7.2/zh/weapon/11401.json";
    const asset = "UI_EquipIcon_Sword_Zephyrus";
    const original = `/assets/gi/${asset}.webp`;
    const path = "data/items/简体中文/gi/weapon/11401.json";
    const imagePath = `gallery/gi/${asset}.webp`;
    const urls: string[] = [];
    let description = "旧版明细";
    let fail = false;
    const request: AtlasSourceFetch = async (url, init) => {
      const { origin, pathname } = new URL(url);
      expect(origin).toBe("https://static.nanoka.cc");
      expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
      urls.push(pathname);
      if (pathname === index) return Response.json({ "11401": { zh: "西风剑", icon: asset } });
      if (pathname === detail) {
        return fail ? new Response(null, { status: 400 }) : Response.json({ name: "西风剑", icon: asset, desc: description });
      }
      if (pathname === original) return new Response(new Uint8Array(webp));
      throw new Error(pathname);
    };
    const read = async (candidate: string) => {
      expect(Buffer.from(await Bun.file(join(candidate, imagePath)).arrayBuffer())).toEqual(webp);
      return (await Bun.file(join(candidate, path)).json()).content.detail.desc;
    };
    const ingest = (source: string, pages: Parameters<typeof copyAtlasSelectedPages>[2]) =>
      copyAtlasSelectedPages(source, archive, pages);
    const baseline = join(archive, "data");
    const normal = (seed?: string) => downloadAtlasVersion(work, target, versions, read, undefined, request, selection, seed);
    const refresh = (directory = work) => redownloadAtlasVersion(directory, target, versions, read, undefined, request, selection, baseline);
    await downloadAtlasVersion(work, target, versions, ingest, undefined, request, selection);
    expect(urls.splice(0)).toEqual([index, detail, original]);

    description = "同索引下的新明细";
    await copyAtlasSelectedPages(archive, cachedExport, [{ ...selection[0], version: versions.gi, recordCount: 1 }]);
    expect(await normal(baseline)).toBe("旧版明细");
    expect(urls.splice(0)).toEqual([index]);
    expect(await refresh()).toBe(description);
    expect(urls.splice(0)).toEqual([index, detail]);
    expect(await refresh()).toBe(description);
    expect(urls.splice(0)).toEqual([index, detail]);

    fail = true;
    await expect(refresh()).rejects.toThrow("HTTP 400");
    expect(urls.splice(0)).toEqual([index, detail]);
    fail = false;
    await rm(cachedExport, { recursive: true });
    expect(await normal()).toBe("旧版明细");
    expect(urls.splice(0)).toEqual([index]);

    const damaged = Buffer.from(webp).fill(0, 25, 27);
    await Bun.write(join(archive, imagePath), damaged);
    expect(await refresh(join(root, "work-without-art-cache"))).toBe(description);
    expect(urls.splice(0)).toEqual([index, detail, original]);
    expect(Buffer.from(await Bun.file(join(archive, imagePath)).arrayBuffer())).toEqual(damaged);
    expect((await Bun.file(join(archive, path)).json()).content.detail.desc).toBe("旧版明细");
    expect(await Bun.file(join(target, "current")).exists()).toBeFalse();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
