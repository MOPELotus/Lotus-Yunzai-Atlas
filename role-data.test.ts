import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtlasCatalog, findCharacters, findTraditionalEntries, type Character, type Game } from "./catalog.ts";
import { characterGalleryName, normalizeRoleDetails } from "./role-data.ts";

const entry = (game: Game): Character => ({ game, id: "42", version: "1", name: "角色样例", rarity: "五星", path: "items/role.json" });

test("原神同版本角色组合战斗和固有天赋，保留六命与有记录的分项材料", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-role-"));
  try {
    await mkdir(join(root, "items"));
    const character = entry("gi");
    const file = join(root, character.path);
    const image = (fieldPath: string, localPath: string, placeholder = false) => ({ fieldPath, localPath, status: "downloaded", placeholder });
    const images = [image("icon", "gallery/gi/../outside.webp"), image("detail.icon", "gallery/gi/overview.webp"),
      image("detail.skills.0.promote.0.icon", "gallery/gi/skill.png"), image("detail.constellations.0.icon", "gallery/hsr/rank.webp"),
      image("detail.constellations.1.icon", "gallery/gi/rank.webp", true),
      image("detail.materials.ascensions.0.mats.0.icon", "gallery/gi/material.webp")];
    const meta = { gameId: "gi", pageId: "character", recordId: character.id, version: character.version, images };
    const content = { detail: {
      desc: "主描述。", chara_info: { title: "称号甲" },
      skills: [{ name: "普攻", desc: "技能描述", promote: [{ level: 1, desc: ["伤害|{param1:F1P}"], param: [0.5] }] }],
      passives: [{ name: "被动", desc: "效果" }],
      constellations: Array.from({ length: 6 }, (_, index) => ({ name: `命座${index + 1}`, desc: "效果" })),
      materials: {
        ascensions: [{ cost: 7, mats: [{ id: 11, name: "材料甲", count: 2 }] },
          { cost: 8, mats: [{ id: 12, name: "无数量" }, { id: 11, name: "材料甲", count: 3 }] }],
        talents: [[{ mats: [{ id: 13, name: "材料乙", count: 1 }] }]],
      },
    } };
    await writeFile(file, JSON.stringify({ meta, content }));
    const catalog = createAtlasCatalog(root);
    const role = await catalog.roleDetails(character);
    expect(role?.overview).toMatchObject({ name: character.name, description: "主描述。", artwork: "gallery/gi/overview.webp",
      facts: [{ label: "称号", value: "称号甲" }] });
    expect(role?.skills.map(({ title }) => title)).toEqual(["战斗天赋", "固有天赋"]);
    expect(role?.skills[0]?.cards[0]).toMatchObject({ artwork: "gallery/gi/skill.png",
      levels: [{ level: 1, details: [{ label: "伤害", text: "50.0%" }] }] });
    expect(role?.ranks.map(({ rank }) => rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(role?.ranks.slice(0, 2).map(({ artwork }) => artwork)).toEqual([undefined, undefined]);
    expect(role?.materials).toMatchObject([{ title: "角色突破材料", cost: 15,
      items: [{ id: "11", name: "材料甲", count: 5, artwork: "gallery/gi/material.webp" }] },
      { title: "普攻升级材料", items: [{ id: "13", name: "材料乙", count: 1 }] }]);
    await expect(catalog.roleDetails({ ...character, version: "2" })).resolves.toBeUndefined();
    await expect(catalog.roleDetails({ ...character, id: "43" })).resolves.toBeUndefined();
    await writeFile(file, JSON.stringify({ meta: { ...meta, pageId: "weapon" }, content }));
    await expect(catalog.roleDetails(character)).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("原神角色元素按同一条目的正式字段选背景，旅行者仍显示没有神之眼", () => {
  const elements = [
    ["Pyro", "pyro"], ["Hydro", "hydro"], ["Anemo", "anemo"], ["Cryo", "cryo"],
    ["Geo", "geo"], ["Electro", "electro"], ["Dendro", "dendro"],
  ] as const;
  const content = (list: string, detail: string) => ({
    list: { element: list }, detail: { element: detail, chara_info: { vision: "无" } },
  });
  for (const [code, element] of elements) {
    const role = normalizeRoleDetails(entry("gi"), content(code, code), "五星");
    expect(role?.overview.element).toBe(element);
    expect(role?.overview.facts).toEqual([{ label: "神之眼", value: "无" }]);
  }
  expect(normalizeRoleDetails(entry("gi"), content("Hydro", "Pyro"), "五星")?.overview.element).toBeUndefined();
  expect(normalizeRoleDetails(entry("gi"), content("None", "None"), "五星")?.overview.element).toBeUndefined();
  expect(normalizeRoleDetails(entry("gi"), content("", "Pyro"), "五星")?.overview.element).toBeUndefined();
  for (const game of ["hsr", "zzz"] as const) {
    expect(normalizeRoleDetails(entry(game), content("Pyro", "Pyro"), "五星")?.overview.element).toBeUndefined();
  }
});

test("旅行者按同一条目确认性别、元素与射击形态，来源不一致时保留原名", () => {
  const role = (id: string, indexElement: string, detailElement = indexElement, wrongIcon = false) => {
    const character = { ...entry("gi"), id, name: "旅行者" };
    const icon = id.startsWith("10000007") || id === "10000135" ? "UI_AvatarIcon_PlayerGirl" : "UI_AvatarIcon_PlayerBoy";
    return normalizeRoleDetails(character, { list: { element: indexElement, icon }, detail: {
      name: character.name, icon: wrongIcon ? "UI_AvatarIcon_PlayerBoy" : icon, element: detailElement,
      desc: id === "10000134" || id === "10000135" ? "第三人称射击旅行者" : "旅行者的原简介。",
    } }, "五星")?.overview;
  };
  expect(role("10000005-4", "Anemo")).toMatchObject({ name: "旅行者·空（风）", element: "anemo" });
  expect(role("10000007-3", "Hydro")).toMatchObject({ name: "旅行者·荧（水）", element: "hydro" });
  expect(role("10000134", "None")?.name).toBe("旅行者·空（射击）");
  expect(role("10000135", "None")?.name).toBe("旅行者·荧（射击）");
  expect(role("10000007-3", "Hydro", "Pyro")?.name).toBe("旅行者");
  expect(role("10000007-3", "Hydro", "Hydro", true)?.name).toBe("旅行者");
  expect(role("10000007-3", "Pyro")?.name).toBe("旅行者");
  expect(role("10000007-3-8", "Hydro")?.name).toBe("旅行者");
});

test("星铁开拓者只展开已核对角色原名及简介宏，并可按命途名或原 ID 查", () => {
  const man = { ...entry("hsr"), id: "8007", name: "{NICKNAME}" };
  const woman = { ...man, id: "8010" };
  const unknown = { ...woman, id: "8011" };
  const source = { detail: { desc: "登上星穹列车的{F#少女}{M#少年}。" } };
  expect(normalizeRoleDetails(man, source, "五星")?.overview).toMatchObject({ name: "穹·记忆", description: "登上星穹列车的少年。" });
  expect(normalizeRoleDetails(woman, source, "五星")?.overview).toMatchObject({ name: "星·欢愉", description: "登上星穹列车的少女。" });
  expect(normalizeRoleDetails(unknown, source, "五星")?.overview).toMatchObject({ name: "{NICKNAME}", description: source.detail.desc });
  const catalog = { pages: [{ game: "hsr", kind: "character", entries: [man, woman, unknown], name: "角色", version: "1", sampled: false }], stale: false } as const;
  expect(findCharacters(catalog, "开拓者")).toEqual([man, woman]);
  expect(findCharacters(catalog, "8007")).toEqual([man]);
  expect(findTraditionalEntries(catalog, "星·欢愉", "hsr", "character").map(({ entry }) => entry)).toEqual([woman]);
});

test("星铁保留技能等级、大行迹和属性小行迹，不猜测材料名或缺失星魂", () => {
  const role = normalizeRoleDetails(entry("hsr"), { detail: {
    base_type: "Warlock", damage_type: "Thunder",
    skills: { "4201": { id: 4201, name: "打击", desc: "造成#1[i]%伤害。", level: { "1": { level: 1, param_list: [0.25] } } } },
    skill_trees: {
      point01: { "1": { point_type: 2, level_up_skill_id: [4201], material_list: [{ item_id: 41, item_num: 3 }] } },
      point02: { "1": { point_name: "能力甲", point_type: 3, point_desc: "回能#1[i]。", param_list: [2] } },
      point03: { "1": { point_name: "属性乙", point_type: 1, status_add_list: [{ name: "攻击力", value: 0.04, property_type: "AttackAddedRatio" }] } },
    },
    ranks: { "1": { name: "星魂甲", desc: "加速" }, "3": { name: "星魂丙", desc: "强化" } },
  } }, "五星");
  expect(role?.overview.facts).toEqual([{ label: "命途", value: "虚无" }, { label: "属性", value: "雷" }]);
  expect(role?.skills[0]?.cards[0]?.levels?.[0]?.description).toBe("造成25%伤害。");
  expect(role?.skills[1]?.cards).toMatchObject([{ name: "能力甲", description: "回能2。" },
    { name: "属性乙", details: [{ label: "攻击力", text: "4%" }] }]);
  expect(role?.ranks.map(({ rank }) => rank)).toEqual([1, 3]);
  expect(role?.materials).toMatchObject([{ title: "行迹材料", items: [{ id: "41", count: 3 }] }]);
  expect(role?.materials[0]?.items[0]?.name).toBeUndefined();
});

test("绝区零分组保留动作、倍率、两套核心等级、影画故事及材料 ID", () => {
  const role = normalizeRoleDetails(entry("zzz"), { detail: {
    partner_info: { profile_desc: "角色简介。" }, weapon_type: { 1: "强攻" },
    skill: { basic: { description: [{ name: "普通攻击", desc: "点按 <IconMap:Icon_Normal>。" },
      { name: "倍率", param: [{ name: "一段", param: { "1": { main: 4880, growth: 450, format: "%" } } }] }],
    material: { "2": { "10": 100 } } } },
    passive: { level: {
      "11": { level: 1, name: ["核心被动", "额外能力"], desc: ["被动甲", "能力甲"] },
      "21": { level: 1, name: ["核心被动", "额外能力"], desc: ["被动乙", "能力乙"] },
    }, materials: { "1": { "10": 5 } } },
    talent: { "1": { level: 1, name: "影画甲", desc: "效果", desc2: "故事" } },
    level: { "1": { materials: { "10": 7, "11": 2 } } },
  } }, "S级");
  expect(role?.overview.description).toBe("角色简介。");
  expect(role?.skills[0]?.cards[0]?.description).toBe("点按 〔普通攻击〕。");
  expect(role?.skills[0]?.cards[1]?.levels).toEqual([{ level: 1, details: [{ label: "一段", text: "48.8%" }] },
    { level: 2, details: [{ label: "一段", text: "53.3%" }] }]);
  expect(role?.skills[1]?.cards[0]?.levels).toMatchObject([
    { level: 1, sourceId: "11", description: "被动甲" }, { level: 1, sourceId: "21", description: "被动乙" },
  ]);
  expect(role?.ranks[0]).toMatchObject({ rank: 1, name: "影画甲", description: "效果", story: "故事" });
  expect(role?.materials).toMatchObject([{ title: "角色晋阶材料", items: [{ id: "10", count: 7 }, { id: "11", count: 2 }] },
    { title: "普通攻击升级材料", items: [{ id: "10", count: 100 }] },
    { title: "核心技升级材料", items: [{ id: "10", count: 5 }] }]);
  expect(normalizeRoleDetails(entry("zzz"), { list: { rank: 4 } }, "S级")).toBeUndefined();
});

test("星见雅保留原图册全名，索引短名和其他角色标题不变", () => {
  const miyabi = { ...entry("zzz"), id: "1091", name: "雅" };
  const content = { detail: { partner_info: { full_name: "星见雅" } } };
  expect(normalizeRoleDetails(miyabi, content, "S级")?.overview.name).toBe("星见雅");
  expect(miyabi.name).toBe("雅");
  expect(normalizeRoleDetails({ ...miyabi, id: "1011" }, content, "A级")?.overview.name).toBe("雅");
  expect(normalizeRoleDetails(miyabi, { detail: { partner_info: { full_name: "异名" } } }, "S级")?.overview.name).toBe("雅");
});

test("安比图册只使用对应角色快照中已核对的全名和原图", () => {
  const anby = { ...entry("zzz"), id: "1011", name: "安比" };
  const soldierZero = { ...anby, id: "1381", name: "零号·安比" };
  const detail = (fullName: string, ultimate: string) => ({ detail: {
    partner_info: { full_name: fullName },
    skill: { chain: { description: [{ name: ultimate }] } },
  } });
  const art = (localPath: string) => [{ fieldPath: "detail.partner_info.role_icon", localPath, status: "downloaded", placeholder: false }];
  const anbyDetails = normalizeRoleDetails(anby, detail("安比·德玛拉", "终结技：过载引擎"), "A级", art("gallery/zzz/IconRole01.webp"));
  const zeroDetails = normalizeRoleDetails(soldierZero, detail("安比·德玛拉", "终结技：斩空掠电"), "S级", art("gallery/zzz/IconRole40.webp"));
  expect(anbyDetails?.overview).toMatchObject({ name: "安比·德玛拉", artwork: "gallery/zzz/IconRole01.webp" });
  expect(zeroDetails?.overview).toMatchObject({ name: "零号·安比", artwork: "gallery/zzz/IconRole40.webp" });
  expect(anbyDetails?.skills[0]?.cards[0]?.name).toBe("终结技：过载引擎");
  expect(zeroDetails?.skills[0]?.cards[0]?.name).toBe("终结技：斩空掠电");
  expect(normalizeRoleDetails(anby, detail("零号·安比", ""), "A级")?.overview.name).toBe("安比");
});

test("猫又与妮可使用已核对的原图册全名", () => {
  const neko = { ...entry("zzz"), id: "1021", name: "猫又" };
  const nicole = { ...neko, id: "1031", name: "妮可" };
  const nekoData = { detail: { partner_info: { full_name: "猫宫又奈" } } };
  const nicoleData = { detail: { partner_info: { full_name: "妮可·德玛拉" } } };
  expect(normalizeRoleDetails(neko, nekoData, "S级")?.overview.name).toBe("猫宫又奈");
  expect(normalizeRoleDetails(nicole, nicoleData, "A级")?.overview.name).toBe("妮可·德玛拉");
  expect(normalizeRoleDetails(neko, nicoleData, "S级")?.overview.name).toBe("猫又");
  expect(normalizeRoleDetails(nicole, nekoData, "A级")?.overview.name).toBe("妮可");
});

test("角色总览优先采用明确登记的主图，独立保留头像与按旧序排列的可验证属性", () => {
  const detail = {
    base_hp: 1191.65, base_atk: 20, crit_rate: 0.05, crit_dmg: 0.5,
    stats_modifier: {
      hp: { 1: 1, 90: 8.738 }, atk: { 1: 1 },
      ascension: [{ fight_prop_base_hp: 4893.559, fight_prop_critical: 0.192 }],
    },
  };
  const images = [
    { fieldPath: "derived.avatarGacha", localPath: "https://example.invalid/gacha.webp", status: "downloaded", placeholder: false },
    { fieldPath: "detail.derived.avatarGacha", localPath: "gallery/gi/unavailable.webp", status: "pending", placeholder: false },
    { fieldPath: "detail.derived.avatarBust", localPath: "gallery/gi/role.webp", status: "downloaded", placeholder: false },
    { fieldPath: "detail.icon", localPath: "gallery/gi/icon.webp", status: "downloaded", placeholder: false },
  ];
  const role = normalizeRoleDetails(entry("gi"), { detail }, "五星", images);
  expect(role?.overview.artwork).toBe("gallery/gi/role.webp");
  expect(role?.overview.icon).toBe("gallery/gi/icon.webp");
  expect(role?.overview.stats).toEqual([
    { label: "Lv1生命", value: "1,192" }, { label: "Lv90生命", value: "15,306" }, { label: "Lv1攻击", value: "20" },
    { label: "暴击率", value: "24.2%" }, { label: "暴击伤害", value: "50%" },
  ]);
  const iconOnly = normalizeRoleDetails(entry("gi"), { detail }, "五星", images.filter(({ fieldPath }) => fieldPath !== "detail.derived.avatarBust"));
  expect(iconOnly?.overview.artwork).toBe(iconOnly?.overview.icon);
});

test("星铁只从首尾晋阶和有效增长值整理总览属性", () => {
  const first = { hp_base: 147.84, attack_base: 92.4, defence_base: 66 };
  const last = { hp_base: 502.656, hp_add: 7.392, attack_base: 314.16, attack_add: "4.62",
    speed_base: 100, critical_chance: 0.05, critical_damage: 0.5 };
  const role = normalizeRoleDetails(entry("hsr"), { detail: { stats: { 0: first, 6: last } } }, "五星");
  expect(role?.overview.stats).toEqual([
    { label: "Lv1生命", value: "148" }, { label: "Lv80生命", value: "1,087" }, { label: "Lv1攻击", value: "92" },
    { label: "Lv1防御", value: "66" }, { label: "速度", value: "100" },
    { label: "暴击率", value: "5%" }, { label: "暴击伤害", value: "50%" },
  ]);
  const partial = normalizeRoleDetails(entry("hsr"), { detail: { stats: { 1: first, 4: last } } }, "五星");
  expect(partial?.overview.stats).toBeUndefined();
});

test("绝区零读取实际等级上限、晋阶增益和基础攻击附加值", () => {
  const role = normalizeRoleDetails(entry("zzz"), { detail: {
    stats: { hp_max: 617, hp_growth: 837238, attack: 135, attack_growth: 82578, defence: 49, defence_growth: 66203,
      break_stun: 93, crit: 500, crit_damage: 5000 },
    level: {
      1: { level_min: 0, level_max: 10, hp_max: 0, attack: 0, defence: 0 },
      6: { level_min: 50, level_max: 60, hp_max: 2117, attack: 241, defence: 167 },
    },
    extra_level: { 1: { max_level: 15, extra: { 12101: { value: 0 } } }, 2: { max_level: 60, extra: { 12101: { value: 75 } } } },
  } }, "S级");
  expect(role?.overview.stats).toEqual([
    { label: "Lv1生命", value: "617" }, { label: "Lv60生命", value: "7,674" },
    { label: "Lv1攻击", value: "135" }, { label: "Lv60攻击", value: "938" },
    { label: "Lv1防御", value: "49" }, { label: "Lv60防御", value: "607" },
    { label: "冲击力", value: "93" }, { label: "暴击率", value: "5%" }, { label: "暴击伤害", value: "50%" },
  ]);
});

test("角色总览保留同角色、同游戏的原图加载备选及其优先序", () => {
  const art = (fieldPath: string, localPath: string, placeholder = false) => ({
    fieldPath, localPath, placeholder, status: "downloaded",
  });
  const images = [
    art("detail.partner_info.role_icon", "gallery/zzz/role.webp"),
    art("icon", "gallery/zzz/index.webp"),
    art("detail.derived.avatarDrawCard", "gallery/hsr/other-game.webp"),
    art("portrait", "gallery/zzz/placeholder.webp", true),
    art("detail.portrait", "gallery/zzz/role.webp"),
    art("derived.avatarDrawCard", "gallery/zzz/card.webp"),
    art("detail.icon", "gallery/zzz/detail.webp"),
    art("detail.skills.0.icon", "gallery/zzz/skill.webp"),
  ];
  const role = normalizeRoleDetails(entry("zzz"), { detail: { desc: "角色描述" } }, "S级", images);
  expect(role?.overview).toMatchObject({
    artwork: "gallery/zzz/card.webp", portraitFallbacks: ["gallery/zzz/role.webp"],
    icon: "gallery/zzz/detail.webp", iconFallback: "gallery/zzz/index.webp",
  });
});

test("图库文件夹按游戏与已核形态选择，同名记录无法互借立绘", () => {
  const base = { game: "gi", id: "10000089", name: "芙宁娜", path: "", rarity: "", version: "7.2" } as const;
  const sameName = { ...base, id: "10000090", name: "芙寧娜" };
  expect(characterGalleryName(base, [base, { ...sameName, game: "hsr", name: base.name }])).toBe(base.name);
  expect(characterGalleryName(base, [base, { ...sameName, name: base.name }])).toBeUndefined();
  const trailblazer = { ...base, game: "hsr", id: "8008", name: "{NICKNAME}" } as const;
  const sibling = { ...trailblazer, id: "8007" };
  expect(characterGalleryName(trailblazer, [sibling, trailblazer])).toBe("星·记忆");
  expect(characterGalleryName(sibling, [sibling, trailblazer])).toBe("穹·记忆");
  expect(characterGalleryName({ ...trailblazer, id: "8099" }, [])).toBeUndefined();
  const march = { ...trailblazer, id: "1001", name: "三月七" };
  const hunt = { ...march, id: "1224" };
  expect(characterGalleryName(march, [march, hunt])).toBe("三月七");
  expect(characterGalleryName(hunt, [march, hunt])).toBe("三月七·巡猎");
});
