import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Game } from "./catalog.ts";
import { createAtlasCatalog } from "./catalog.ts";
import { completeAtlasRoleMaterials, pendingAtlasRoleMaterials } from "./role-material-source.ts";
import type { AtlasSourceFetch } from "./source-transport.ts";

const webp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");

test("角色材料按游戏和角色数据版本联查，保留直接名称和原数量并可离线重用", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-role-items-"));
  const data = join(root, "data");
  const scopes = [{ game: "gi", version: "7.2" }, { game: "hsr", version: "4.7" },
    { game: "zzz", version: "3.4.5+20699967" }] as const;
  const details: Record<Game, unknown> = {
    gi: { materials: { ascensions: [{ mats: [{ id: 10, name: "原详情中的角色材料", count: 3 }] }] } },
    hsr: { stats: [{ cost: [{ item_id: 10, item_num: 4 }] }] },
    zzz: { level: [{ materials: { "10": 5, "11": 2 } }] },
  };
  const itemTables: Record<Game, unknown> = {
    gi: { "10": { name: "物品表中的原材料", icon: "UI_ItemIcon_Genuine" } },
    hsr: { "10": { id: 10, item_name: "星铁材料", item_figure_icon_path: "SpriteOutput/ItemFigures/Original.png" } },
    zzz: { "10": { id: 10, name: "丁尼", icon_path: "Assets/NapResources/UI/Sprite/ItemIcon/IconCoin.png" },
      "11": { id: 10, name: "不匹配", icon_path: "wrong.png" } },
  };
  const selected = scopes.map(page => ({ ...page, pageId: "character" }));
  try {
    await mkdir(join(data, "items"), { recursive: true });
    const games: Record<string, unknown> = {};
    for (const { game, version } of scopes) {
      const path = `items/${game}.json`;
      const indexEntry = { id: "1", name: "资料角色", rarity: "A", path, hasDetail: true };
      games[game] = { locales: { zh: { pages: { character: { id: "character", version, sampled: false,
        recordCount: 1, totalRecordCount: 1, records: { "1": indexEntry } } } } } };
      await Bun.write(join(data, path), JSON.stringify({
        meta: { gameId: game, version, name: indexEntry.name, recordId: "1", pageId: "character",
          locale: "zh", hasDetail: true, images: [] },
        content: { list: { name: indexEntry.name }, detail: details[game] },
      }));
    }
    await Bun.write(join(data, "map.json"), JSON.stringify({ games }));
    const paths: string[] = [];
    let starRailAvailable = false;
    const request: AtlasSourceFetch = async (url) => {
      const entry = new URL(url);
      expect(entry.origin).toBe("https://static.nanoka.cc");
      paths.push(entry.pathname);
      for (const { game, version } of scopes) {
        if (entry.pathname !== `/${game}/${version}/zh/item_all.json`) continue;
        if (game === "hsr" && !starRailAvailable) return new Response(null, { status: 404 });
        return Response.json(itemTables[game]);
      }
      if (entry.pathname === "/assets/gi/UI_ItemIcon_Genuine.webp" ||
          entry.pathname === "/assets/hsr/itemfigures/Original.webp" || entry.pathname === "/assets/zzz/IconCoin.webp") {
        return new Response(webp);
      }
      throw new Error(`意外请求 ${url}`);
    };
    expect(await pendingAtlasRoleMaterials(data, selected)).toEqual(selected);
    const starRail = selected.find(page => page.game === "hsr")!;
    const otherGames = selected.filter(page => page.game !== "hsr");
    expect(await completeAtlasRoleMaterials(root, selected, undefined, request)).toEqual(otherGames);
    expect(paths).toHaveLength(5);
    expect(await pendingAtlasRoleMaterials(data, selected)).toEqual([starRail]);
    starRailAvailable = true;
    expect(await completeAtlasRoleMaterials(root, selected, undefined, request)).toEqual([starRail]);
    expect(paths).toHaveLength(7);
    expect(await completeAtlasRoleMaterials(root, selected, undefined, request)).toEqual([]);
    expect(paths).toHaveLength(7);
    const catalog = createAtlasCatalog(data);
    const { pages } = await catalog.read();
    expect(pages).toHaveLength(3);
    const expected = { gi: ["原详情中的角色材料", 3, "UI_ItemIcon_Genuine"],
      hsr: ["星铁材料", 4, "itemfigures/Original"], zzz: ["丁尼", 5, "IconCoin"] } as const;
    for (const page of pages) {
      const item = (await catalog.roleDetails(page.entries[0]!))?.materials[0]?.items[0];
      const [name, count, suffix] = expected[page.game];
      expect(item).toEqual({ id: "10", name, count, artwork: `gallery/${page.game}/materials/${suffix}.webp` });
      expect(await Bun.file(join(root, item!.artwork!)).exists()).toBeTrue();
      if (page.game === "zzz") {
        expect((await catalog.roleDetails(page.entries[0]!))?.materials[0]?.items[1])
          .toEqual({ id: "11", name: undefined, count: 2, artwork: undefined });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
