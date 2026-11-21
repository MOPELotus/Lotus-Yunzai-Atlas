import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadAtlasVersion } from "./download-legacy-atlas.ts";
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
