import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtlasCatalog, type AtlasEntry } from "./catalog.ts";
import { normalizeWeapon } from "./weapon-data.ts";

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
    expect(await catalog.weaponDetails(entry)).toEqual({ game: "gi", name: entry.name, version: entry.version,
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
  const partial = normalizeWeapon(entry, { detail: { stats_modifier: { atk: { base: 20, levels: { 1: 1, 90: 10 } } } } }, []);
  expect(partial?.stats).toEqual([{ label: "Lv1基础攻击力", value: "20" }]);
  expect(normalizeWeapon(entry, { list: { type: "WEAPON_SWORD_ONE_HAND" } }, [])).toBeUndefined();
});

test("原神一二星武器按实际第四次晋阶计算 Lv70，即使曲线还包含 Lv90", () => {
  for (const [rarity, base, first, max] of [[1, 23.245, "23", "185"], [2, 32.93, "33", "243"]] as const) {
    const detail = {
      rarity, stats_modifier: { atk: { base, levels: { 1: 1, 70: 5.968, 90: 7.346 } } },
      ascension: { 4: { fight_prop_base_attack: 46.7 } },
    };
    expect(normalizeWeapon(entry, { detail }, [])?.stats).toEqual([
      { label: "Lv1基础攻击力", value: first }, { label: "Lv70基础攻击力", value: max },
    ]);
    expect(normalizeWeapon(entry, { list: { rank: rarity }, detail: { ...detail, rarity: undefined } }, [])?.stats.at(-1))
      .toEqual({ label: "Lv70基础攻击力", value: max });
  }
  const partial = normalizeWeapon({ ...entry, rarity: "一星" }, { detail: {
    stats_modifier: { atk: { base: 23.245, levels: { 1: 1, 70: 5.968, 90: 7.346 } } },
    ascension: { 3: { fight_prop_base_attack: 31.1 } },
  } }, []);
  expect(partial?.stats).toEqual([{ label: "Lv1基础攻击力", value: "23" }]);
});

test("光锥以真实晋阶上限计算属性，并按各叠影参数还原效果", () => {
  const details = normalizeWeapon({ ...entry, game: "hsr" }, { detail: {
    stats: [{ max_level: 20, base_hp: 40, base_attack: 20, base_defence: 12 },
      { max_level: 80, base_hp: 480, base_hp_add: 4, base_attack: 160, base_attack_add: 2, base_defence: 100 }],
    refinements: { name: "效果", desc: "提升<unbreak>#1[i]%</unbreak>，持续#2[i]回合。", level: {
      1: { param_list: [0.12, 3] }, 5: { level: 5, param_list: [0.24, 3] },
    } },
  } }, [
    { fieldPath: "derived.path", localPath: "gallery/hsr/path.webp", status: "downloaded", placeholder: false },
    { fieldPath: "derived.lightConeMediumIcon", localPath: "gallery/hsr/cone.webp", status: "downloaded", placeholder: false },
  ]);
  expect(details?.artwork).toBe("gallery/hsr/cone.webp");
  expect(details?.stats).toEqual([
    { label: "Lv1生命", value: "40" }, { label: "Lv80生命", value: "796" },
    { label: "Lv1攻击", value: "20" }, { label: "Lv80攻击", value: "318" },
    { label: "Lv1防御", value: "12" },
  ]);
  expect(details?.refinements).toEqual([
    { rank: 1, name: "效果", description: "提升12%，持续3回合。" },
    { rank: 5, name: "效果", description: "提升24%，持续3回合。" },
  ]);
});

test("音擎按等级和晋阶数据计算首末属性，改装保留自身效果", () => {
  const details = normalizeWeapon({ ...entry, game: "zzz" }, { detail: {
    desc: "样例说明。", base_property: { name: "基础攻击力", value: 48 },
    rand_property: { name: "暴击率", format: "{0:0.#%}", value: 960 },
    level: { 0: { rate: 0 }, 60: { rate: 94090 }, remaster: { rate: 1_000_000 } },
    stars: { 0: { star_rate: 0, rand_rate: 0 }, 5: { star_rate: 44610, rand_rate: 15000 } },
    talents: { 1: { name: "技能", desc: "冰属性伤害提升25%。" }, 5: { name: "技能", desc: "冰属性伤害提升50%。" } },
  } }, []);
  expect(details?.stats).toEqual([
    { label: "Lv1基础攻击力", value: "48" }, { label: "Lv60基础攻击力", value: "714" },
    { label: "Lv1暴击率", value: "9.6%" }, { label: "Lv60暴击率", value: "24%" },
  ]);
  expect(details?.refinements).toEqual([
    { rank: 1, name: "技能", description: "冰属性伤害提升25%。" },
    { rank: 5, name: "技能", description: "冰属性伤害提升50%。" },
  ]);
});

test("光锥叠影的整数占位按游戏截断，保留浮点占位显示精度", () => {
  const details = normalizeWeapon({ ...entry, game: "hsr" }, { detail: {
    refinements: { name: "测试", desc: "恢复#1[i]点能量，治疗量提高#2[i]%，倍率#3[f2]%，阈值#4[i]%。",
      level: { 2: { param_list: [7.5, 0.125, 0.0036, 0.29] }, 4: { param_list: [10.5, 0.175, 0.0054, 0.27] } },
    },
  } }, []);
  expect(details?.refinements).toEqual([
    { rank: 2, name: "测试", description: "恢复7点能量，治疗量提高12%，倍率0.36%，阈值29%。" },
    { rank: 4, name: "测试", description: "恢复10点能量，治疗量提高17%，倍率0.54%，阈值27%。" },
  ]);
  const weapon = normalizeWeapon(entry, { detail: {
    refinement: { 1: { name: "别的游戏", desc: "比例#1[i]%。", param_list: [0.125] } },
  } }, []);
  expect(weapon?.refinements[0]?.description).toBe("比例13%。");
});

test("原神装备介绍去掉样式标签并保留原文、换行及登记的原图", () => {
  const path = "gallery/gi/UI_EquipIcon_Sword_WeaponQuestSnezhnaya01.webp";
  const weapon = normalizeWeapon({ ...entry, id: "390002", name: "星锋剑·源光" }, { detail: {
    desc: "闪映着蓦然辉光。\\n\\n<i>「看啊，我的功业已成。」</i>",
    story: "<b>原故事</b>",
    refinement: { 1: { name: "效果", desc: "<i>回复#1[f1]点。</i>", param_list: [1.5] } },
  } }, [{ status: "downloaded", placeholder: false, fieldPath: "detail.icon", localPath: path }]);
  expect(weapon).toMatchObject({
    name: "星锋剑·源光",
    artwork: path,
    description: "闪映着蓦然辉光。\n\n「看啊，我的功业已成。」",
    story: "原故事",
    refinements: [{ rank: 1, name: "效果", description: "回复1.5点。" }],
  });
});
