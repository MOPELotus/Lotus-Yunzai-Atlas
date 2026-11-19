import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtlasCatalog, type AtlasEntry } from "./catalog.ts";
import { normalizeGenshinWeapon } from "./weapon-data.ts";

const entry: AtlasEntry = { game: "gi", id: "11401", version: "sample", name: "武器样例", rarity: "四星", path: "items/weapon.json" };

test("原神武器详情保留实测等级、精炼顺序和已下载的图鉴图标", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-weapon-"));
  try {
    await mkdir(join(root, "items"));
    const file = join(root, entry.path);
    const meta = { gameId: "gi", pageId: "weapon", recordId: entry.id, version: entry.version, images: [
      { fieldPath: "detail.icon", status: "downloaded", placeholder: false, localPath: "gallery/gi/../outside.webp" },
      { fieldPath: "icon", status: "downloaded", placeholder: false, localPath: "gallery/gi/weapon.webp" },
    ] };
    const content = { detail: {
      desc: "样例描述。", story: "样例故事。",
      stats_modifier: {
        atk: { base: 41.0671, levels: { 1: 1, 90: 7.275 } },
        fight_prop_charge_efficiency: { base: 0.133333, levels: { 1: 1, 90: 4.594 } },
        fight_prop_element_mastery: { base: 55, levels: { 1: 1, 90: "2" } },
      },
      ascension: { 6: { fight_prop_base_attack: 155.6 } },
      refinement: { 1: { name: "效果", desc: "提升<color=#FFFFFF>#1[i]%</color>。", param_list: [0.6] },
        5: { name: "效果", desc: "提升100%。" }, 6: { name: "非精炼" } },
    } };
    await writeFile(file, JSON.stringify({ meta, content }));
    const catalog = createAtlasCatalog(root);
    expect(await catalog.weaponDetails(entry)).toEqual({ name: entry.name, version: entry.version,
      description: "样例描述。", story: "样例故事。", artwork: "gallery/gi/weapon.webp",
      stats: [{ label: "Lv1基础攻击力", value: "41" }, { label: "Lv90基础攻击力", value: "454" },
        { label: "Lv1元素充能效率", value: "13.3%" }, { label: "Lv90元素充能效率", value: "61.3%" },
        { label: "Lv1元素精通", value: "55" }],
      refinements: [{ rank: 1, name: "效果", description: "提升60%。" }, { rank: 5, name: "效果", description: "提升100%。" }],
    });
    expect(await catalog.weaponDetails({ ...entry, version: "later" })).toBeUndefined();
    expect(await catalog.weaponDetails({ ...entry, id: "unrelated" })).toBeUndefined();
    expect(await catalog.weaponDetails({ ...entry, game: "zzz" })).toBeUndefined();
    await writeFile(file, JSON.stringify({ meta: { ...meta, pageId: "artifact" }, content }));
    expect(await catalog.weaponDetails(entry)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("缺少末次突破数值时不推定满级基础攻击，纯索引仍可返回文本", () => {
  const partial = normalizeGenshinWeapon(entry, { detail: { stats_modifier: { atk: { base: 20, levels: { 1: 1, 90: 10 } } } } }, []);
  expect(partial?.stats).toEqual([{ label: "Lv1基础攻击力", value: "20" }]);
  expect(normalizeGenshinWeapon(entry, { list: { type: "WEAPON_SWORD_ONE_HAND" } }, [])).toBeUndefined();
});
