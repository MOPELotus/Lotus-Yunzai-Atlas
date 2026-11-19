import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtlasCatalog } from "./catalog.ts";

test("末日长卡保留同版本增益参数、星启和实际阵容，只接受登记的难度变体", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-apocalypse-"));
  try {
    const version = "4.7.52";
    const enemyName = "合金机铠•帕姆王";
    const artwork = "gallery/hsr/monsterfigure/Monster_5014020.webp";
    const fixture = {
      games: { hsr: { locales: { zh: { pages: {
        maze_boss: { version, recordCount: 1,
          records: { "3022": { id: "3022", name: "领航冥茫", path: "items/3022.json" } } },
        monster: { version, recordCount: 1,
          records: { "5014024": { id: "5014024", name: enemyName, path: "items/5014024.json" } } },
      } } } } },
    };
    const put = (pageId: string, id: string, content: unknown, images: unknown[] = []) => writeFile(
      join(root, "items", `${id}.json`), JSON.stringify({ meta: { gameId: "hsr", pageId, version, recordId: id, images }, content }),
    );
    await mkdir(join(root, "items"));
    await writeFile(join(root, "map.json"), JSON.stringify(fixture));
    const optional = { name: "破竹之势", desc: "伤害提高<unbreak>#1[i]%</unbreak>。", param: [0.3] };
    await put("maze_boss", "3022", {
      list: { live_begin: "2026-11-16 04:00:00", live_end: "2026-12-28 04:00:00",
        begin: "2026-09-27 04:00:02", end: "2026-12-18 04:00:00" },
      detail: {
        id: 3022,
        buff: { name: "末法余烬", desc: "战技伤害提高#1[i]%，欢愉伤害提高#2[i]%。", param: [0.25, 0.15] },
        buff_list1: [optional], buff_list2: [optional],
        level: [
          { id: 30224, name: "领航冥茫·难度<unbreak>04</unbreak>", damage_type1: ["Fire", "Quantum"],
            challenge: [{ name: "获得#1分", param: 6600 }],
            event_id_list1: [{ stage_id: 420564, level: 90,
              monster_list: [{ monster0: 501402404, other_id: 501402401 }],
              invasion: { level: 3, monster_list: [{ monster_id: 501402401 }] } }],
            event_id_list2: [{ level: 90, monster_list: [{ monster0: 501402499 }] }] },
          { id: 30225, pre_id: 30224, damage_type: ["Physical"], challenge: [{ name: "获得#1分", param: 9900 }],
            challenge_special: { name: "获得#1分", param: 10200 },
            event_id_list: [{ level: 90, monster_list: [{ monster0: 501402404 }] }] },
        ],
      },
    });
    await put("monster", "5014024", {
      list: { child: [501402401, 501402404, 501402499] },
      detail: { id: 5014024, name: enemyName, desc: "同源敌人介绍。",
        child: [{ id: 501402401 }, { id: 501402404 }] },
    }, [{ status: "downloaded", placeholder: false, fieldPath: "icon", localPath: artwork }]);

    const catalog = createAtlasCatalog(root);
    const snapshot = await catalog.read();
    const entry = snapshot.pages.find((page) => page.challengeMode?.id === "maze_boss")?.entries[0];
    expect(entry).toBeDefined();
    const result = await catalog.apocalypseDetails(entry!, snapshot, true);
    expect(result?.window).toEqual({ from: "live", begin: "2026-11-16 04:00:00", end: "2026-12-28 04:00:00" });
    expect(result?.effect.description).toBe("战技伤害提高25%，欢愉伤害提高15%。");
    expect(result?.optional).toEqual([{ name: "破竹之势", description: "伤害提高30%。" }]);
    expect(result?.rooms[0]?.goals).toEqual(["获得6600分"]);
    expect(result?.rooms[0]?.sides[0]).toEqual({
      name: "上半", weaknesses: ["火", "量子"], enemies: [
        { name: enemyName, level: 90, artwork, description: "同源敌人介绍。" },
        { name: enemyName, level: undefined, artwork, description: "同源敌人介绍。" },
      ],
    });
    expect(result?.rooms[0]?.sides[1]?.enemies[0]?.name).toBe("敌人 ID 501402499（待核对）");
    expect(result?.rooms[1]?.name).toBe("领航冥茫·难度04 · 星启模式");
    expect(result?.rooms[1]?.goals).toEqual(["获得9900分", "额外目标 获得10200分"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
