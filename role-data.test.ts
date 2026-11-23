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
  expect(role("10000005-4", "Anemo")).toMatchObject({ name: "旅行者·空（风）", element: "anemo",
    traveler: { name: "旅行者·空（风）", portraitBase: "10000005" } });
  expect(role("10000007-3", "Hydro")).toMatchObject({ name: "旅行者·荧（水）", element: "hydro",
    traveler: { name: "旅行者·荧（水）", portraitBase: "10000007" } });
  expect(role("10000134", "None")?.traveler).toEqual({ name: "旅行者·空（射击）" });
  expect(role("10000135", "None")?.traveler).toEqual({ name: "旅行者·荧（射击）" });
  expect(role("10000007-3", "Hydro", "Pyro")?.name).toBe("旅行者");
  expect(role("10000007-3", "Hydro", "Hydro", true)?.name).toBe("旅行者");
  expect(role("10000007-3", "Pyro")?.name).toBe("旅行者");
  expect(role("10000007-3-8", "Hydro")?.name).toBe("旅行者");
  expect(role("10000007-3", "Hydro", "Hydro", true)?.traveler).toBeUndefined();
});

test("星铁角色简介以开拓者显示原昵称宏，其他词句和未知性别保留", () => {
  const kafka = { ...entry("hsr"), id: "1005", name: "卡芙卡" };
  const desc = "利用言灵术，设计令{NICKNAME}吸收星核。";
  expect(normalizeRoleDetails(kafka, { detail: { desc } }, "五星")?.overview.description)
    .toBe("利用言灵术，设计令开拓者吸收星核。");
  const unresolved = "{F#她}{M#他}称{NICKNAME}为同伴。";
  expect(normalizeRoleDetails(kafka, { list: { desc: unresolved }, detail: { id: 1005 } }, "五星")?.overview.description)
    .toBe("{F#她}{M#他}称开拓者为同伴。");
  expect(normalizeRoleDetails(entry("gi"), { detail: { desc } }, "五星")?.overview.description).toBe(desc);
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

test("绝区零图库接受同一角色经过核验的全名，保留短名与同游戏名称冲突保护", () => {
  const ellen = { game: "zzz", id: "1191", name: "艾莲", path: "", rarity: "", version: "3.3" } as const;
  const collision = { ...ellen, id: "9999", name: "艾莲·乔" };
  expect(characterGalleryName(ellen, [ellen], "艾莲·乔")).toEqual(["艾莲", "艾莲·乔"]);
  expect(characterGalleryName(ellen, [ellen], "艾莲·乔的其他形态")).toBe("艾莲");
  expect(characterGalleryName(ellen, [ellen, collision], "艾莲·乔")).toBe("艾莲");
  expect(characterGalleryName(ellen, [ellen, { ...collision, game: "hsr" }], "艾莲·乔"))
    .toEqual(["艾莲", "艾莲·乔"]);
});

test("角色分项保持旧满级基础数据，原神缺少 100 级曲线才回到可核实的 90 级", () => {
  const modifiers = { hp: { "90": 8.739, "100": 9.652 }, atk: { "90": 8.739, "100": 11.629 },
    def: { "90": 8.739, "100": 9.652 }, ascension: [{ fight_prop_base_hp: 4893.559,
      fight_prop_base_attack: 77.987366, fight_prop_base_defense: 222.3585, fight_prop_critical: 0.192 }] };
  const genshin = (data: object) => normalizeRoleDetails(entry("gi"), { detail: {
    base_hp: 1191.65, base_atk: 18.9924, base_def: 54.14615, stats_modifier: data,
  } }, "五星")?.overview;
  expect(genshin(modifiers)?.sectionStats).toMatchObject({ level: 100,
    rows: [{ label: "基础生命" }, { label: "基础攻击" }, { label: "基础防御" }, { label: "暴击", value: "19.2%" }] });
  expect(genshin({ ...modifiers, hp: { "90": 8.739 } })?.sectionStats?.level).toBe(90);
  expect(genshin({ ...modifiers, hp: {} })?.sectionStats).toBeUndefined();

  const rail = normalizeRoleDetails(entry("hsr"), { detail: { stats: { "6": {
    hp_base: 502.656, hp_add: 7.392, attack_base: 314.16, attack_add: 4.62,
    defence_base: 224.4, defence_add: 3.3, speed_base: 100,
  } } } }, "五星");
  expect(rail?.overview.sectionStats).toEqual({ level: 80,
    rows: [{ label: "基础生命", value: "1,086.6" }, { label: "基础攻击", value: "679.1" },
      { label: "基础防御", value: "485.1" }, { label: "速度", value: "100" }] });
});

test("专用技能图沿用原等级区间及大行迹，整册仍保留完整条目", () => {
  const original = normalizeRoleDetails(entry("gi"), { detail: {
    skills: [{ name: "普攻", promote: Array.from({ length: 15 }, (_, i) =>
      ({ level: i + 1, desc: ["伤害|1.0%"] })) }],
  } }, "五星");
  const talent = original?.skills[0]?.cards[0];
  expect(talent?.levels).toHaveLength(15);
  expect(talent?.sectionLevels?.map(({ level }) => level)).toEqual([6, 7, 8, 9, 10, 11, 12, 13]);
  const rail = normalizeRoleDetails(entry("hsr"), { detail: {
    skills: [{ id: 100501, name: "普攻", type_name: "普攻", desc: "攻击", level: [{ level: 1 }, { level: 8 }] },
      { id: 100506, name: "攻击", desc: "大世界普通攻击" }],
    skill_trees: { a: { "1": { point_type: 1, point_name: "小行迹" } },
      b: { "1": { point_type: 3, point_name: "额外能力" } } },
  } }, "五星");
  expect(rail?.skills[0]?.cards[0]?.levels?.map(({ level }) => level)).toEqual([1, 8]);
  expect(rail?.skills[0]?.cards[0]?.sectionLevels?.map(({ level }) => level)).toEqual([1]);
  expect(rail?.skills[0]?.cards[1]?.omitFromSection).toBe(true);
  expect(rail?.skills[1]?.cards.map(({ omitFromSection }) => omitFromSection)).toEqual([true, false]);
});

test("星铁专用分项把倍率代回正文并注明旧代表等级，保留精确参数的每级表格", () => {
  const row = (level: number, params: number[]) => ({ level, param_list: params });
  const role = normalizeRoleDetails(entry("hsr"), { detail: { skills: [{
    name: "普攻", type_name: "普攻", desc: "造成#1[i]%攻击，持续#2[i]回合。",
    simple_desc: "攻击。", level: [row(1, [0.5, 2]), row(5, [0.9, 2]), row(7, [1.1, 2]), row(8, [1.2, 2])],
  }, {
    name: "战技", type_name: "战技", desc: "造成#1[i]%伤害。\n追加#3[i]%伤害。",
    level: [row(6, [1.2, 2, 0.45]), row(8, [1.4, 2, 0.525]), row(12, [1.76, 2, 0.66])],
  }] } }, "五星");
  const [basic, skill] = role!.skills[0]!.cards;
  expect(basic?.description).toBe("攻击。");
  expect(basic?.sectionDescription).toBe("造成90.0% (Lv5)攻击，持续2回合。");
  expect(basic?.sectionLevels?.[1]?.details).toEqual([{ label: "正文第 1 项", text: "90.0%" }]);
  expect(skill?.sectionDescription).toBe("造成140.0% (Lv8)伤害。\n追加52.5% (Lv8)伤害。");
  expect(skill?.sectionLevels?.[1]?.details).toEqual([
    { label: "正文第 1 项", text: "140.0%" }, { label: "正文第 2 项", text: "52.5%" },
  ]);
});

test("星铁旧忆灵分项恢复昔涟主动后被动的顺序，仅专用技能卡读取对应同角色槽位", () => {
  const memo = (name: string, type_name: string, desc = "效果提高<unbreak>#1[i]%</unbreak>。") => ({
    name, type_name, desc, level: [{ level: 1, param_list: [0.3] }, { level: 5, param_list: [0.54] }],
  });
  const role = normalizeRoleDetails({ ...entry("hsr"), id: "1415" }, { detail: {
    skills: [{ name: "看，希望的起始！", type_name: "普攻" }],
    skill_trees: { point1: { "1": { point_type: 3, point_name: "额外能力" } } },
    memosprite: { skills: {
      "1141505": memo("「你好，世界♪」", "忆灵天赋", "解除控制。"),
      "1141503": memo("等待，在所有的过去", "忆灵天赋"),
      "1141501": memo("花与箭的舞曲", "忆灵技"),
      "1141502": { ...memo("此诗，献予一切生命", "忆灵技",
        "获得<icon SpriteName=AvatarCyrene id=0 width=1 height=1>特殊效果，提高#1[i]%。"), exclusive: true },
      "1141526": { ...memo("献予「真我」之诗", "忆灵技"), link: { link_avatar: 1415 } },
      "1141527": { ...memo("献予「其它」之诗", "忆灵技"), link: { link_avatar: 1415 } },
      "1141513": { ...memo("献予「创世」之诗", "忆灵技"), link: { link_avatar: 8007 } },
      "1141514": memo("献予「不能核实」之诗", "忆灵技"),
      "1141506": memo("错误的能力类别", "忆灵技"),
      "1140907": memo("其他角色的忆灵能力", "忆灵技"),
    } },
  } }, "五星", [{ fieldPath: "detail.memosprite.icon", localPath: "gallery/hsr/memo.webp", status: "downloaded", placeholder: false }]);
  expect(role?.skills.map(({ title }) => title)).toEqual(["技能", "行迹"]);
  expect(role?.sectionSkills?.map(({ title }) => title)).toEqual(["技能", "忆灵技能", "行迹"]);
  const memoCards = role?.sectionSkills?.[1]?.cards ?? [];
  expect(memoCards.map(({ name }) => name)).toEqual(["花与箭的舞曲", "此诗，献予一切生命", "等待，在所有的过去", "「你好，世界♪」"]);
  expect(memoCards[0]).toMatchObject({ sectionDescription: "效果提高54.0% (Lv5)。", memospriteIcon: "me", artwork: "gallery/hsr/memo.webp" });
  expect(memoCards[1]?.sectionDescription).toBe("获得特殊效果，提高54.0% (Lv5)。");
  expect(memoCards[1]?.linkedEffects?.map(({ name, sectionDescription }) => [name, sectionDescription])).toEqual([
    ["献予「创世」之诗", "效果提高54.0% (Lv5)。"], ["献予「真我」之诗", "效果提高54.0% (Lv5)。"],
  ]);
  expect(memoCards[2]?.memospriteIcon).toBe("mt");
  expect(memoCards[3]).toMatchObject({ sectionDescription: "解除控制。", sectionLevels: [] });
  expect(normalizeRoleDetails({ ...entry("hsr"), id: "1005" }, {
    detail: { skills: [{ name: "夜间喧嚣不止", type: "Normal" }] },
  }, "五星")?.sectionSkills?.map(({ title }) => title)).toEqual(["技能"]);
  const march = normalizeRoleDetails({ ...entry("hsr"), id: "1413" }, {
    detail: { memosprite: { skills: { "1141307": memo("迷梦，流失，如露", "忆灵技") } } },
  }, "五星");
  expect(march?.sectionSkills?.[0]?.cards[0]?.name).toBe("迷梦，流失，如露");
});

test("星铁专用技能按同一行迹升级点并拢实际战斗形态，仅收有类别的能力", () => {
  const skill = (id: number, name: string, type: string | null, type_name = "") => ({ id, name, type, type_name, desc: name });
  const detail = {
    skills: {
      "121301": skill(121301, "泽芝", "Normal", "普攻"), "121302": skill(121302, "龙力自在", "BPSkill", "战技"),
      "121303": skill(121303, "苍龙傲睨，劫水濯世", "Ultra", "终结技"), "121304": skill(121304, "亢心", null, "天赋"),
      "121308": skill(121308, "瞬华", "Normal", "普攻"), "121309": skill(121309, "取消", "BPSkill", "战技"),
      "121310": skill(121310, "天矢阴", "Normal", "普攻"), "121312": skill(121312, "盘拏耀跃", "Normal", "普攻"),
      "121319": skill(121319, "攻击", "MazeNormal"), "121320": skill(121320, "不明功能", null),
    },
    skill_trees: {
      point01: { "1": { point_type: 2, level_up_skill_id: [121301, 121308, 121310, 121312] } },
      point02: { "1": { point_type: 2, level_up_skill_id: [121302] } },
      point03: { "1": { point_type: 2, level_up_skill_id: [121303, 121304] } },
      stray: { "1": { point_type: 2, level_up_skill_id: [121303, 121319, 121320] } },
    },
  };
  const rail = normalizeRoleDetails({ ...entry("hsr"), id: "1213" }, { detail }, "五星");
  const source = rail?.skills[0]?.cards;
  const section = rail?.sectionSkills?.[0]?.cards;
  expect(source).toHaveLength(10);
  expect(source?.every(card => !card.sectionVariants)).toBe(true);
  expect(section?.map(({ name }) => name)).toEqual(["泽芝", "龙力自在", "苍龙傲睨，劫水濯世", "亢心"]);
  expect(section?.[0]?.sectionVariantTitle).toBe("强化普攻");
  expect(section?.[0]?.sectionVariants?.map(({ name }) => name)).toEqual(["瞬华", "天矢阴", "盘拏耀跃"]);
  expect(section?.[1]?.sectionVariants?.map(({ name }) => name)).toEqual(["取消"]);
  expect(section?.[2]?.sectionVariants).toBeUndefined();
});

test("星铁强化技能保留公式里的非百分比小数系数", () => {
  const row = (level: number, param_list: number[]) => ({ level, param_list });
  const role = normalizeRoleDetails({ ...entry("hsr"), id: "1310" }, { detail: { skills: {
    "131002": { id: 131002, name: "指令-天火轰击", type_name: "战技" },
    "131009": { id: 131009, name: "火萤Ⅳ型-死星过载", type_name: "战技",
      desc: "(#2[f1]×击破特攻+#1[f1]%)攻击力，相邻比例#3[f1]。",
      level: [row(6, [1.5, 0.2, 0.1]), row(8, [1.75, 0.2, 0.1]), row(12, [2.1, 0.2, 0.1])] },
  }, skill_trees: { point02: { "1": { point_type: 2, level_up_skill_id: [131002, 131009] } } } } }, "五星");
  const enhanced = role?.sectionSkills?.[0]?.cards[0]?.sectionVariants?.[0];
  expect(enhanced?.sectionDescription).toBe("(0.2×击破特攻+175.0% (Lv8))攻击力，相邻比例0.1。");
  expect(enhanced?.sectionLevels?.[1]?.details).toEqual([{ label: "正文第 1 项", text: "175.0%" }]);
});
