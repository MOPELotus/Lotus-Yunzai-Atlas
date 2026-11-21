import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtlasCatalog, findTraditionalEntries } from "./catalog.ts";
import { normalizeGenshinCard } from "./gcg-data.ts";
import { acquireAtlasSource } from "./source-acquisition.ts";
import { atlasSourcePlan } from "./refresh-source.ts";

const version = "7.2";
const icon = "UI_Gcg_CardFace_Modify_Talent_Ayaka";
const index = {
  "1105": { zh: "神里绫华", type: "Character", hp: 10, icon: "UI_Gcg_CardFace_Char_Avatar_Ayaka" },
  "211051": { zh: "寒天宣命祝词", type: "Action", icon },
};
const character = { name: "神里绫华", type: "Character", icon: index["1105"].icon, tag: ["冰元素"], hp: 10, talent: {
  "11051": { name: "神里流·倾", desc: "造成$[D__KEY__DAMAGE]点$[D__KEY__ELEMENT]。", child: {
    d_key_damage: 2, d_key_element: "GCG_ELEMENT_CRYO",
  }, cost: { gcg_cost_dice_cryo: 1, gcg_cost_dice_void: 2, gcg_cost_energy: 3 } },
} };
const action = { name: "寒天宣命祝词", type: "Action", icon, tag: ["天赋"], desc: "雪鹤衔冰，翼影翩翩。",
  cost: [{ cost_type: "GCG_COST_DICE_CRYO", count: 2 }, {}], talent: {
    name: "寒天宣命祝词", desc: "装备有此牌的$[A1105]生成$[C111052]。",
    child: { a1105: "应当使用同版主索引的角色名", c111052: { name: "{SPRITE_PRESET#2101}<color=#FFFFFFFF>冰元素附魔</color>" } },
  } };

test("正式七圣详情沿用原始字段、角色/行动和同版姓名，缺牌面保留内容", () => {
  expect(normalizeGenshinCard("211051", version, { list: index["211051"], detail: action, references: { a1105: "神里绫华" } }, []))
    .toMatchObject({ name: "寒天宣命祝词", type: "行动牌", cost: "冰 ×2", description: "雪鹤衔冰，翼影翩翩。",
      artwork: undefined, skills: [{ description: "装备有此牌的神里绫华生成冰元素附魔。" }] });
  expect(normalizeGenshinCard("1105", version, { list: index["1105"], detail: character }, []))
    .toMatchObject({ name: "神里绫华", type: "角色牌", hp: 10,
      skills: [{ description: "造成2点冰元素伤害。", cost: "冰 ×1 / 任意 ×2 / 充能 ×3" }] });
  expect(normalizeGenshinCard("211051", version, { list: index["211051"], detail: character }, [])).toBeUndefined();
});

test("正式同版接入新增七圣分类，原名称查卡但同名不改角色归属", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-gcg-"));
  try {
    const requests: string[] = [];
    const source = await acquireAtlasSource(join(root, "source"), [{ game: "gi", pageId: "gcg", version, recordCount: 2 }], undefined,
      async (address, options) => {
        const url = new URL(address);
        expect(url.origin).toBe("https://static.nanoka.cc");
        expect(options.credentials).toBe("omit");
        expect(options.redirect).toBe("error");
        expect(new Headers(options.headers).get("Cookie")).toBeNull();
        requests.push(url.pathname);
        if (url.pathname.endsWith("/gcg.json")) return Response.json(index);
        if (/\/gcg\/(?:card|skill|keyword)\.json$/u.test(url.pathname)) return Response.json({ "1": { name: "引用夹具" } });
        if (url.pathname.endsWith("/1105.json")) return Response.json(character);
        if (url.pathname.endsWith("/211051.json")) return Response.json(action);
        return new Response(null, { status: 404 });
      });
    expect(requests).toEqual([
      "/gi/7.2/gcg.json", "/gi/7.2/zh/gcg/card.json", "/gi/7.2/zh/gcg/keyword.json", "/gi/7.2/zh/gcg/skill.json",
      "/gi/7.2/zh/gcg/1105.json", "/assets/gi/UI_Gcg_CardFace_Char_Avatar_Ayaka.webp",
      "/gi/7.2/zh/gcg/211051.json", "/assets/gi/UI_Gcg_CardFace_Modify_Talent_Ayaka.webp",
    ]);
    expect(source.missingImageCount).toBe(2);
    const map = JSON.parse(await readFile(join(source.directory, "data", "map.json"), "utf8"));
    expect(map.games.gi.locales.zh.pages.gcg.recordCount).toBe(2);
    const reader = createAtlasCatalog(join(source.directory, "data"));
    const catalog = await reader.read();
    expect(findTraditionalEntries(catalog, "寒天宣命祝词")[0]).toMatchObject({ kind: "gcg", entry: { id: "211051" } });
    const card = findTraditionalEntries(catalog, "1105", "gi")[0]?.entry;
    expect(card?.name).toBe("神里绫华");
    expect(findTraditionalEntries(catalog, "寒天宣命祝词", "zzz")).toEqual([]);
    expect(findTraditionalEntries(catalog, "寒天宣命祝词", "gi", "weapon")).toEqual([]);
    const colliding: typeof catalog = { ...catalog, pages: [...catalog.pages, { game: "gi", kind: "character", name: "角色", sampled: false,
      version, entries: [{ ...card!, id: "10000002" }] }] };
    expect(findTraditionalEntries(colliding, "神里绫华")[0]?.kind).toBe("character");
    expect(await reader.genshinCardDetails(findTraditionalEntries(catalog, "寒天宣命祝词")[0]!.entry))
      .toMatchObject({ skills: [{ description: "装备有此牌的神里绫华生成冰元素附魔。" }] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("缺七圣分类的有效现用快照允许新增，普通未校验快照仍禁止更新", () => {
  const manifest = { gi: { live: "7.2", latest: "7.2.52", available: ["7.2", "7.2.52"] } };
  const baseline = { ok: true, pages: [{ game: "gi", pageId: "character", version, recordCount: 1 }] as const, issues: [], issueCount: 0 };
  expect(atlasSourcePlan("gi/gcg", manifest, baseline).candidateRequirements).toEqual([{ game: "gi", pageId: "gcg", version }]);
  expect(atlasSourcePlan("gi/weapon", manifest, baseline).entries).toMatchObject([{ action: "review", reason: "local-unverified" }]);
  expect(atlasSourcePlan("gi/gcg", manifest, { ...baseline, ok: false }).entries).toMatchObject([{ action: "review", reason: "local-unverified" }]);
});
