import { createHash } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { branchAndBladeIcon, effectText, label, object } from "./source-values.ts";
import { mazeIndexMatches, mazeSourceOutline } from "./maze-source-data.ts";
import { isMonsterGroupPage, monsterGroupKey } from "./monster-group-data.ts";
import { readAchievementCategories } from "./achievements.ts";
import { bossSourceImages, bossSourceIndex } from "./boss-source-data.ts";
import { shiyuSourceImages, shiyuSourceIndex } from "./shiyu-source-data.ts";
import { matchesZzzCharacterDetail, zzzCharacterImages, zzzCharacterIndexIcon } from "./zzz-character-source.ts";
import { validateAtlasCandidate, type AtlasCandidatePage } from "./validate-candidate.ts";

import { atlasSourceOrigin, isAtlasSourceWebp, readAtlasSourceBytes, type AtlasSourceFetch } from "./source-transport.ts";
const locale = "zh";
const versions = /^(0|[1-9]\d{0,7})(?:\.(?:0|[1-9]\d{0,7})){1,3}(?:\+(?:0|[1-9]\d{0,14}))?$/u;
const bangbooImages = "UI/Sprite/A1DynamicLoad/BangbooModGarage/UnPacker/BangbooRole";
const weaponImages = "Assets/NapResources/UI/Sprite/A1DynamicLoad/ItemIconWeapon/UnPacker";
const driveDiscImages = "UI/Sprite/A1DynamicLoad/IconSuit/UnPacker";
const bangbooIcon = new RegExp(`^${bangbooImages}/([A-Za-z0-9_-]{1,120})\\.png$`, "u");
const driveDiscIcon = new RegExp(`^${driveDiscImages}/(Suit[A-Za-z0-9_-]{1,116}|${branchAndBladeIcon})\\.png$`, "u");
const weaponIcon = /^Weapon_[A-Za-z0-9_-]{1,113}$/u;
const genshinArtifactIcon = /^UI_RelicIcon_[A-Za-z0-9_]{1,100}$/u;
// Both sets have the same confirmed original 404s in the legacy export and the formal release.
const missingGenshinArtifactIcons = new Map([
  ["15004", new Set(["UI_RelicIcon_15004_1", "UI_RelicIcon_15004_2", "UI_RelicIcon_15004_3",
    "UI_RelicIcon_15004_4", "UI_RelicIcon_15004_5"])],
  ["15012", new Set(["UI_RelicIcon_15012_3"])],
]);
const genshinArtifactSlots = ["equip_ring", "equip_necklace", "equip_dress", "equip_bracer", "equip_shoes"] as const;
const genshinWeaponIcon = /^[A-Za-z0-9_]{1,120}$/u;
const genshinWeaponTypes = new Set(["WEAPON_SWORD_ONE_HAND", "WEAPON_CLAYMORE", "WEAPON_POLE", "WEAPON_CATALYST", "WEAPON_BOW", "ITEM_TPS_WEAPON"]);
const genshinRarities = ["", "一星", "二星", "三星", "四星", "五星"] as const;
const genshinSingleRefinement = new Set(["11412", "11416", "15415"]);
const genshinMissingIcons = new Map([["224008", "Sword_Template"], ["380002", "UI_EquipIcon_Claymore_LoliFriend"]]);
const genshinStats = new Set(["atk", "fight_prop_attack_percent", "fight_prop_defense_percent", "fight_prop_hp_percent",
  "fight_prop_critical", "fight_prop_critical_hurt", "fight_prop_element_mastery", "fight_prop_charge_efficiency", "fight_prop_physical_add_hurt"]);
const lightconeRarities = new Map([
  ["CombatPowerLightconeRarity3", "三星"], ["CombatPowerLightconeRarity4", "四星"], ["CombatPowerLightconeRarity5", "五星"],
]);
const lightconePaths = new Set(["Warrior", "Rogue", "Mage", "Shaman", "Warlock", "Knight", "Priest", "Memory", "Elation"]);
const pages = {
  "zzz/character": { game: "zzz", pageId: "character", title: "Character", folder: "绝区零角色", timeout: 600_000, maxRecords: 256 },
  "zzz/bangboo": { game: "zzz", pageId: "bangboo", title: "Bangboo", folder: "邦布", timeout: 180_000, maxRecords: 256 },
  "zzz/weapon": { game: "zzz", pageId: "weapon", title: "Weapon", folder: "音擎", timeout: 180_000, maxRecords: 256 },
  "zzz/equipment": { game: "zzz", pageId: "equipment", title: "Drive Disc", folder: "驱动盘", timeout: 180_000, maxRecords: 256 },
  "hsr/EliteGroup": { game: "hsr", pageId: "EliteGroup", title: "Elite Group", folder: "星铁精英组", timeout: 60_000, maxRecords: 4096 },
  "hsr/HardLevelGroup": { game: "hsr", pageId: "HardLevelGroup", title: "Difficulty Group", folder: "星铁难度组", timeout: 60_000, maxRecords: 4096 },
  "hsr/InfiniteEliteGroup": { game: "hsr", pageId: "InfiniteEliteGroup", title: "Infinite Elite Group", folder: "星铁无限精英组", timeout: 60_000, maxRecords: 4096 },
  "hsr/maze": { game: "hsr", pageId: "maze", title: "Memory of Chaos", folder: "混沌回忆", timeout: 180_000, maxRecords: 256 },
  "hsr/monster": { game: "hsr", pageId: "monster", title: "Monster", folder: "星铁敌人", timeout: 900_000, maxRecords: 4096 },
  "hsr/monstervalue": { game: "hsr", pageId: "monstervalue", title: "Monster Values", folder: "星铁敌人数值", timeout: 60_000, maxRecords: 4096 },
  "hsr/relicset": { game: "hsr", pageId: "relicset", title: "Relic Set", folder: "星铁遗器", timeout: 180_000, maxRecords: 256 },
  "hsr/lightcone": { game: "hsr", pageId: "lightcone", title: "Light Cone", folder: "光锥", timeout: 360_000, maxRecords: 256 },
  "zzz/achievement/achievement": { game: "zzz", pageId: "achievement/achievement", title: "Achievement", folder: "绝区零成就", timeout: 60_000, maxRecords: 3 },
  "gi/achievement/achievement": { game: "gi", pageId: "achievement/achievement", title: "Achievement", folder: "原神成就", timeout: 180_000, maxRecords: 256 },
  "hsr/achievement/achievement": { game: "hsr", pageId: "achievement/achievement", title: "Achievement", folder: "星铁成就", timeout: 60_000, maxRecords: 256 },
  "gi/artifact": { game: "gi", pageId: "artifact", title: "Artifact Set", folder: "原神圣遗物", timeout: 360_000, maxRecords: 256 },
  "gi/weapon": { game: "gi", pageId: "weapon", title: "Weapon", folder: "武器", timeout: 600_000, maxRecords: 512 },
  "zzz/boss": { game: "zzz", pageId: "boss", title: "Deadly Assault", folder: "危局强袭战", timeout: 360_000, maxRecords: 256 },
  "zzz/shiyu": { game: "zzz", pageId: "shiyu", title: "Shiyu Defense", folder: "式舆防卫战", timeout: 360_000, maxRecords: 256 },
} as const;
type SourcePage = keyof typeof pages;
const maxJsonBytes = 1024 * 1024;
const maxLargeIndexBytes = 2 * 1024 * 1024;
const maxIconBytes = 2 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const placeholderPath = "gallery/_placeholder/unknown.svg";
// Keep the owner's legacy placeholder bytes so old and new classifications can share its gallery path.
const placeholder = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-label="Missing image"><rect width="256" height="256" rx="36" fill="#141827"/><path d="M62 176 98 132l29 35 22-27 45 56H62Z" fill="#2b3248"/><circle cx="183" cy="76" r="18" fill="#39435e"/><path d="M128 58c-24 0-42 14-45 36h30c2-8 8-13 16-13 9 0 15 5 15 13 0 7-4 12-15 20-17 12-24 23-23 41h28c0-10 4-16 17-25 16-11 25-23 25-39 0-20-19-33-48-33Z" fill="#b8c0d9"/><circle cx="120" cy="188" r="15" fill="#b8c0d9"/></svg>\n`;

const placeholderImage = { status: "placeholder", placeholder: true, placeholderReason: "remote_missing", remoteUrl: null,
  localPath: placeholderPath, contentType: "image/svg+xml", bytes: Buffer.byteLength(placeholder),
  sha256: createHash("sha256").update(placeholder).digest("hex") } as const;

function sourcePage(value: string): value is SourcePage {
  return Object.hasOwn(pages, value);
}

export interface AtlasAcquiredSource {
  readonly directory: string;
  readonly pages: readonly Required<AtlasCandidatePage>[];
  readonly imageCount: number;
  readonly missingImageCount: number;
}

async function sourceJson(url: string, optional: boolean, signal: AbortSignal, request: AtlasSourceFetch, limit = maxJsonBytes) {
  const bytes = await readAtlasSourceBytes(url, "application/json", limit, optional, signal, request, { retry: true });
  return bytes === undefined ? undefined : JSON.parse(utf8.decode(bytes)) as unknown;
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { flag: "wx" });
}

const monsterStatRanks = new Set(["Minion", "MinionLv2", "Elite", "LittleBoss", "BigBoss"]);
const monsterWeaknesses = new Set(["Fire", "Ice", "Imaginary", "Physical", "Quantum", "Thunder", "Wind"]);

function monsterFigure(value: unknown): string | undefined {
  if (value === "SpriteOutput/BattleEventIcon/Monster_Unknown.png") return "Monster_Unknown";
  if (typeof value === "string") return /^SpriteOutput\/MonsterFigure\/(Monster_[A-Za-z0-9_]{1,100}|BossIconTemporary)\.png$/u.exec(value)?.[1];
}

function monsterPhases(count: unknown, phases: unknown): boolean {
  if (count === undefined && phases === undefined) return true;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 1 &&
    Array.isArray(phases) && phases.length === count && phases.every((row, index) => {
      const { phase_num, phase_max_hp_ratio } = object(row);
      return phase_num === index + 1 && nonnegative(phase_max_hp_ratio);
    });
}

function monsterStatsIndexRow(value: Record<string, unknown>): boolean {
  const { Rank, MaxMonsterPhase, PhaseList, child } = value;
  if (typeof Rank !== "string" || !monsterStatRanks.has(Rank) ||
      ![value.AttackBase, value.DefenceBase, value.HPBase].every(nonnegative) ||
      ![value.SpeedBase, value.StanceBase, value.StatusResistanceBase].every(field => field === null || nonnegative(field)) ||
      !Array.isArray(child)) return false;
  if (!monsterPhases(MaxMonsterPhase, PhaseList)) return false;

  const ids = new Set<number>();
  return child.every(row => {
    const { Id, AttackModifyRatio, DefenceModifyRatio, EliteGroup, HPModifyRatio, SpeedModifyRatio, SpeedModifyValue,
      StanceModifyRatio, HardLevelGroup, StanceWeakList } = object(row);
    if (typeof Id !== "number" || !Number.isSafeInteger(Id) || Id <= 0 || ids.has(Id) ||
        ![EliteGroup, HardLevelGroup].every(group => typeof group === "number" && Number.isSafeInteger(group) && group >= 0) ||
        ![AttackModifyRatio, DefenceModifyRatio, HPModifyRatio, SpeedModifyRatio, StanceModifyRatio].every(nonnegative) ||
        (SpeedModifyValue !== null && (typeof SpeedModifyValue !== "number" || !Number.isFinite(SpeedModifyValue))) ||
        !Array.isArray(StanceWeakList) || !StanceWeakList.every(weakness => monsterWeaknesses.has(weakness))) return false;
    ids.add(Id);
    return true;
  });
}

function sourceIndex(category: SourcePage, value: unknown) {
  const { folder, maxRecords, pageId } = pages[category];
  if (isMonsterGroupPage(pageId)) {
    if (!Array.isArray(value) || !value.length || value.length > maxRecords) {
      throw new Error(`${folder}索引必须是完整数组。`);
    }
    const keys = new Set<string>();
    return value.map((row, position) => {
      const key = monsterGroupKey(pageId, row);
      if (!key || keys.has(key)) throw new Error(`${folder}存在结构错误或重复主键（第 ${position} 项）。`);
      keys.add(key);
      const id = String(position);
      return { id, list: object(row), name: id, rarity: "未分类", rank: undefined, iconName: undefined, pathName: undefined };
    });
  }

  const entries = Object.entries(object(value));
  if (entries.length === 0 || entries.length > maxRecords) throw new Error(`${folder}索引条目数无效。`);
  if (category === "zzz/achievement/achievement") {
    const tables = ["category", "achievement", "mutual_type"];
    if (entries.length !== tables.length || tables.some(table => !Object.hasOwn(object(value), table))) {
      throw new Error("绝区零成就缺少原始分类、条目或互斥表。");
    }
    return entries.map(([id, list]) => {
      if (list !== object(list)) throw new Error(`绝区零成就来源表 ${id} 结构无效。`);
      return { id, list: object(list), name: id, rarity: "未分类", rank: undefined, iconName: undefined, pathName: undefined };
    });
  }
  return entries.map(([id, value]) => {
    const list = object(value);
    const { zh, rank, icon, type } = list;
    if (category === "gi/achievement/achievement" || category === "hsr/achievement/achievement") {
      const name = label(list.name);
      if (!/^(0|[1-9]\d{0,9})$/u.test(id) || !name ||
          (category === "gi/achievement/achievement" && (typeof icon !== "string" || !/^UI_AchievementIcon_[A-Za-z0-9_]{1,100}$/u.test(icon)))) {
        throw new Error(`${folder}来源索引条目结构无效。`);
      }
      return { id, list, name, rarity: "未分类", iconName: typeof icon === "string" && category === "gi/achievement/achievement" ? icon : undefined };
    }
    if (category === "zzz/equipment") {
      const texts = object(zh);
      const { name } = texts;
      const iconName = typeof icon === "string" ? driveDiscIcon.exec(icon)?.[1] : undefined;
      if (!/^[1-9]\d{0,9}$/u.test(id) || typeof name !== "string" || !name.trim() || !iconName ||
          !effectText(texts.desc2) || !effectText(texts.desc4)) throw new Error("驱动盘来源索引条目结构无效。");
      return { id, list, name: name.trim(), rarity: "未分类", iconName };
    }
    if (category === "hsr/monstervalue") {
      if (!/^[1-9]\d{0,9}$/u.test(id) || !monsterStatsIndexRow(list)) {
        throw new Error(`星铁敌人数值来源索引条目结构无效（${id}）。`);
      }
      return { id, list, name: id, rarity: "未分类", iconName: undefined };
    }
    if (category === "gi/artifact") {
      const effects = Object.entries(object(list.set));
      const name = label(object(object(effects[0]?.[1]).name).zh);
      if (!/^[1-9]\d{0,9}$/u.test(id) || list.id !== Number(id) || !name ||
          typeof icon !== "string" || !genshinArtifactIcon.test(icon) ||
          !Array.isArray(rank) || rank.length === 0 || new Set(rank).size !== rank.length ||
          rank.some(value => !Number.isInteger(value) || value < 1 || value > 5) ||
          (effects.length !== 1 && effects.length !== 2) ||
          effects.some(([key, value]) => !/^[1-9]\d{0,9}$/u.test(key) ||
            label(object(object(value).name).zh) !== name || !effectText(object(object(value).desc).zh))) {
        throw new Error("原神圣遗物来源索引条目结构无效。");
      }
      return { id, list, name, rarity: "未分类", iconName: icon };
    }
    if (!/^[1-9]\d{0,9}$/u.test(id) || typeof zh !== "string" || !zh.trim()) throw new Error(`${folder}来源索引条目结构无效。`);
    const name = zh.trim();
    if (category === "zzz/character") {
      const iconName = zzzCharacterIndexIcon(icon);
      if (!iconName || (rank !== 3 && rank !== 4)) throw new Error(`绝区零角色来源索引条目结构无效（${id}）。`);
      return { id, list, name, rank, rarity: rank === 4 ? "S级" : "A级", iconName };
    }
    if (category === "hsr/maze") {
      if (!mazeIndexMatches(id, list)) throw new Error(`混沌回忆索引身份或轮换时间无效（${id}）。`);
      return { id, list, name, rarity: "未分类", iconName: undefined };
    }
    if (category === "hsr/monster") {
      const figure = monsterFigure(icon);
      if (!figure || typeof rank !== "string" || !monsterStatRanks.has(rank) ||
          !Array.isArray(list.weak) || !list.weak.every(weakness => monsterWeaknesses.has(weakness)) ||
          !Array.isArray(list.child) || !list.child.every(variant => Number.isSafeInteger(variant) && variant > 0) ||
          new Set(list.child).size !== list.child.length) throw new Error(`星铁敌人来源索引条目结构无效（${id}）。`);
      return { id, list, name, rarity: rank === "MinionLv2" ? "二星" : "未分类", iconName: `monsterfigure/${figure}` };
    }
    if (category === "hsr/relicset") {
      const match = typeof icon === "string" && /^SpriteOutput\/ItemIcon\/([1-9]\d{0,9})\.png$/u.exec(icon);
      const effects = object(list.set);
      if (!match || !Object.hasOwn(effects, "2") ||
          Object.entries(effects).some(([count, value]) => {
            const { zh, ParamList } = object(value);
            return (count !== "2" && count !== "4") || !Array.isArray(ParamList) || !effectText(zh, ParamList);
          })) throw new Error("星铁遗器来源索引条目结构无效。");
      return { id, list, name, rarity: "未分类", iconName: `itemfigures/${match[1]}` };
    }
    if (category === "hsr/lightcone") {
      const rarity = typeof rank === "string" ? lightconeRarities.get(rank) : undefined;
      if (!rarity || typeof list.baseType !== "string" || !lightconePaths.has(list.baseType)) {
        throw new Error("光锥来源索引条目结构无效。");
      }
      return { id, list, name, rarity, pathName: list.baseType.toLowerCase() };
    }
    if (category === "gi/weapon") {
      const rarity = typeof rank === "number" && Number.isInteger(rank) ? genshinRarities[rank] : undefined;
      const special = list.skin === true || type === "ITEM_TPS_WEAPON";
      if (!rarity || typeof type !== "string" || !genshinWeaponTypes.has(type) || typeof icon !== "string" ||
          id.length !== (special ? 6 : 5)) {
        throw new Error("原神武器来源索引条目结构无效。");
      }
      if (list.skin === true && list.tag === "TAG_TYPE_COLOR_BY_ELEMENT" && /^UI_EquipIcon_[A-Za-z0-9_]+_\{0\}$/u.test(icon)) {
        return { id, list, name, rank, rarity };
      }
      if (!genshinWeaponIcon.test(icon)) throw new Error("原神武器来源图标标识无效。");
      return { id, list, name, rank, rarity, iconName: icon };
    }
    if (typeof icon !== "string" || (rank !== 3 && rank !== 4 && !(category === "zzz/weapon" && rank === 2))) {
      throw new Error(`${folder}来源索引条目结构无效。`);
    }
    const rarity = rank === 4 ? "S级" : rank === 3 ? "A级" : "B级";
    if (category === "zzz/weapon") {
      if (!weaponIcon.test(icon) || typeof type !== "number" || !Number.isInteger(type) || type < 1 || type > 7 ||
          typeof list.atk !== "number" || !Number.isSafeInteger(list.atk) || list.atk <= 0) {
        throw new Error("音擎来源索引条目结构无效。");
      }
      return { id, list, name, rank, rarity, iconName: icon };
    }
    const iconName = bangbooIcon.exec(icon)?.[1];
    if (icon !== "" && !iconName) throw new Error("邦布来源索引条目结构无效。");
    return { id, list, name, rank, rarity, iconName };
  });
}

function lightconeDetail(item: Record<string, unknown>, id: string, list: Record<string, unknown>): boolean {
  if (item.rarity !== list.rank || item.base_type !== list.baseType || !Array.isArray(item.stats) || item.stats.length !== 7) return false;
  const statFields = ["base_hp", "base_hp_add", "base_attack", "base_attack_add", "base_defence", "base_defence_add"];
  if (!item.stats.every((value, index) => {
    const stage = object(value);
    return stage.equipment_id === Number(id) && stage.max_level === (index + 2) * 10 && statFields.every((key) => {
      const field = stage[key];
      return typeof field === "number" && Number.isFinite(field) && field >= 0;
    });
  })) return false;
  const { name, desc, level } = object(item.refinements);
  const refinements = object(level);
  return typeof name === "string" && name.trim().length > 0 && typeof desc === "string" && desc.trim().length > 0 &&
    Object.keys(refinements).length === 5 &&
    [1, 2, 3, 4, 5].every((rank) => {
      const { level, param_list } = object(refinements[rank]);
      return (level === undefined || level === rank) && Array.isArray(param_list);
    });
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function completeEngineCurve(value: unknown, first: number, count: number, fields: readonly string[]): boolean {
  const rows = object(value);
  return Object.keys(rows).length === count &&
    Array.from({ length: count }, (_, index) => first + index)
      .every((index) => fields.every((field) => nonnegative(object(rows[index])[field])));
}

function engineDetail(item: Record<string, unknown>, list: Record<string, unknown>): boolean {
  if (!effectText(item.desc) || !label(item.desc2) || !label(item.desc3) || !label(item.materials) ||
      !completeEngineCurve(item.level, 0, 61, ["rate", "rate2"]) ||
      !completeEngineCurve(item.stars, 0, 6, ["star_rate", "rand_rate"])) return false;
  const base = object(item.base_property);
  const extra = object(item.rand_property);
  if (!label(base.name) || !nonnegative(base.value) || !label(extra.name) || !label(extra.format) || !nonnegative(extra.value)) return false;
  const growth = object(object(item.level)[60]).rate;
  const upgrade = object(object(item.stars)[5]).star_rate;
  // The published index truncates the computed attack. The old card formats the raw value separately.
  if (!nonnegative(growth) || !nonnegative(upgrade) || Math.floor(base.value * (10_000 + growth + upgrade) / 10_000) !== list.atk) {
    return false;
  }
  const talents = object(item.talents);
  return Object.keys(talents).length === 5 && [1, 2, 3, 4, 5].every((rank) => {
    const { name, desc, param, param_list } = object(talents[rank]);
    const params = Array.isArray(param) ? param : Array.isArray(param_list) ? param_list : undefined;
    return Boolean(label(name) && effectText(desc, params, true));
  });
}

function genshinWeaponDetail(item: Record<string, unknown>, id: string, list: Record<string, unknown>): boolean {
  if (item.rarity !== list.rank || item.weapon_type !== list.type || item.icon !== list.icon ||
      item.skin !== list.skin || item.tag !== list.tag) return false;
  if (list.skin === true || list.type === "ITEM_TPS_WEAPON") return true;

  const lowRank = list.rank === 1 || list.rank === 2;
  const cap = lowRank ? 70 : 90;
  const stageCount = lowRank ? 4 : 6;
  const ascension = object(item.ascension);
  const materials = object(item.materials);
  if (Object.keys(ascension).length !== stageCount || Object.keys(materials).length !== stageCount ||
      !Array.from({ length: stageCount }, (_, index) => index + 1).every((stage) =>
        nonnegative(object(ascension[stage]).fight_prop_base_attack) && Object.keys(object(materials[stage])).length > 0)) return false;

  const stats = object(item.stats_modifier);
  const { base, levels } = object(stats.atk);
  const capModifier = object(levels)[cap];
  const bonus = object(ascension[stageCount]).fight_prop_base_attack;
  if (!nonnegative(base) || !nonnegative(capModifier) || !nonnegative(bonus) || Math.round(base * capModifier + bonus) !== list.atk ||
      Object.keys(stats).length !== (lowRank ? 1 : 2)) return false;
  const levelNumbers = Array.from({ length: cap }, (_, index) => index + 1);
  if (!Object.entries(stats).every(([property, value]) => {
    const { base, levels } = object(value);
    const curve = object(levels);
    return genshinStats.has(property) && nonnegative(base) && levelNumbers.every((level) => nonnegative(curve[level]));
  })) return false;

  const refinement = object(item.refinement);
  const expectedRankCount = lowRank ? 0 : genshinSingleRefinement.has(id) ? 1 : 5;
  return Object.keys(refinement).length === expectedRankCount &&
    Array.from({ length: expectedRankCount }, (_, index) => index + 1).every((rank) => {
      const { name, desc, param_list } = object(refinement[rank]);
      return typeof name === "string" && name.trim().length > 0 && typeof desc === "string" && desc.trim().length > 0 && Array.isArray(param_list);
    });
}

function genshinArtifactDetail(item: Record<string, unknown>, id: string, list: Record<string, unknown>): boolean {
  const listed = object(list.set);
  const single = Object.keys(listed).length === 1;
  const parts = object(item.parts);
  const slots = single ? ["equip_dress"] : genshinArtifactSlots;
  const needed = single ? [1] : [2, 4];
  const { affix, need, rank } = item;
  if (item.id !== Number(id) || item.icon !== list.icon || JSON.stringify(rank) !== JSON.stringify(list.rank) ||
      !Array.isArray(affix) || affix.length !== needed.length || JSON.stringify(need) !== JSON.stringify(needed) ||
      Object.keys(parts).length !== slots.length) return false;
  if (!slots.every(slot => {
    const { name, icon } = object(parts[slot]);
    return label(name) && typeof icon === "string" && genshinArtifactIcon.test(icon);
  })) return false;

  const affixIds = new Set<string>();
  for (const value of affix) {
    const { affix_id, name, desc } = object(value);
    if (typeof affix_id !== "number" || !Number.isSafeInteger(affix_id)) return false;
    const key = String(affix_id);
    const source = object(listed[key]);
    if (affixIds.has(key) || name !== object(source.name).zh || desc !== object(source.desc).zh) return false;
    affixIds.add(key);
  }
  return true;
}

function detailMatches(category: SourcePage, detail: unknown, entry: ReturnType<typeof sourceIndex>[number]) {
  const { id, name, rank, iconName, list } = entry;
  const item = object(detail);
  if (category === "gi/artifact") return genshinArtifactDetail(item, id, list);
  if (category === "hsr/maze") return Boolean(mazeSourceOutline(detail, name));
  if (typeof item.name !== "string" || item.name.trim() !== name) return false;
  if (category === "zzz/character") return matchesZzzCharacterDetail(id, list, item);
  if (category === "hsr/lightcone") return lightconeDetail(item, id, list);
  if (category === "hsr/monster") {
    const variants = Array.isArray(item.child) ? item.child.map(object) : undefined;
    if (item.id !== Number(id) || item.image_path !== list.icon || item.rank !== list.rank ||
        (item.desc !== null && typeof item.desc !== "string") ||
        ![item.attack_base, item.defence_base, item.hp_base].every(nonnegative) ||
        ![item.speed_base, item.stance_base, item.status_resistance_base].every(value => value === null || nonnegative(value)) ||
        !Array.isArray(item.drop) || !monsterPhases(item.max_monster_phase, item.phase_list) ||
        !variants || !Array.isArray(list.child) || variants.length !== list.child.length ||
        variants.some(variant => !Array.isArray(variant.skill_list) || !Array.isArray(variant.damage_type_resistance) ||
          !Array.isArray(variant.stance_weak_list) ||
          ![variant.elite_group, variant.hard_level_group].every(group =>
            typeof group === "number" && Number.isSafeInteger(group) && group >= 0))) return false;
    const ids = new Set(variants.map(variant => variant.id));
    return variants.length === ids.size && list.child.every(variant => ids.has(variant));
  }
  if (category === "hsr/relicset") {
    const listed = object(list.set);
    const effects = object(item.require_num);
    const parts = Object.entries(object(item.parts));
    return item.icon === list.icon && parts.length === (Object.hasOwn(listed, "4") ? 4 : 2) &&
      parts.every(([key, value]) => /^[1-9]\d{0,9}$/u.test(key) && label(object(value).name)) &&
      Object.keys(effects).length === Object.keys(listed).length &&
      Object.entries(listed).every(([count, value]) => {
        const summary = object(value);
        const { desc, param_list } = object(effects[count]);
        return Array.isArray(param_list) && summary.zh === desc &&
          JSON.stringify(summary.ParamList) === JSON.stringify(param_list);
      });
  }
  if (category === "gi/weapon") return genshinWeaponDetail(item, id, list);
  if (category === "zzz/equipment") {
    const { name: sourceName, desc2, desc4 } = object(list.zh);
    return item.id === Number(id) && item.name === sourceName && item.desc2 === desc2 && item.desc4 === desc4 &&
      item.icon === list.icon && item.icon2 === list.icon && Boolean(effectText(item.story));
  }
  if (item.id !== Number(id) || item.rarity !== rank) return false;
  if (category === "zzz/bangboo") return true;
  const types = Object.keys(object(item.weapon_type));
  return item.code_name === iconName && item.icon === `${weaponImages}/${iconName}.png` &&
    types.length === 1 && types[0] === String(list.type) && engineDetail(item, list);
}

async function readIcon(name: string, paths: readonly string[], category: SourcePage, target: string,
  signal: AbortSignal, request: AtlasSourceFetch) {
  const { game, folder } = pages[category];
  const localPath = `gallery/${game}/${name}.webp`;
  for (const path of paths) {
    const remoteUrl = `${atlasSourceOrigin}/assets/${game}/${path}.webp`;
    const bytes = await readAtlasSourceBytes(remoteUrl, "image/webp", maxIconBytes, true, signal, request, { retry: true });
    if (!bytes) continue;
    if (!isAtlasSourceWebp(bytes)) throw new Error(`${folder}来源图标不是有效的 WebP 文件。`);
    await mkdir(dirname(join(target, localPath)), { recursive: true });
    await writeFile(join(target, localPath), bytes, { flag: "wx" });
    return { remoteUrl, localPath, sha256: createHash("sha256").update(bytes).digest("hex"),
      contentType: "image/webp", bytes: bytes.length };
  }
}

function imageReference(fieldPath: string, originalValue: unknown, icon: Awaited<ReturnType<typeof readIcon>>) {
  return { fieldPath, originalValue, ...(icon ? { ...icon, status: "downloaded", placeholder: false } : placeholderImage) };
}

/** Fetch a complete verified page into a fresh source root suitable for candidate assembly. */
export async function acquireAtlasSource(destination: string, requirements: readonly AtlasCandidatePage[],
  signal?: AbortSignal, request: AtlasSourceFetch = fetch): Promise<AtlasAcquiredSource> {
  const scope = requirements[0];
  const category = `${scope?.game}/${scope?.pageId}`;
  const publishedChallenge = category === "zzz/boss" || category === "zzz/shiyu";
  if (requirements.length !== 1 || !scope || !sourcePage(category) || typeof scope.version !== "string" ||
      !versions.test(scope.version) || (category !== "zzz/bangboo" && scope.version.includes("+"))) {
    throw new Error("请选择支持抓取的分类及对应版本。");
  }
  const { version } = scope;
  const { game, pageId, folder, title, timeout: limit } = pages[category];
  const timeout = AbortSignal.timeout(limit);
  const active = signal ? AbortSignal.any([signal, timeout]) : timeout;
  active.throwIfAborted();
  const resolved = resolve(destination);
  const target = join(await realpath(dirname(resolved)), basename(resolved));
  const data = join(target, "data");
  const items = `items/${locale}/${game}/${pageId}`;
  await mkdir(target, { mode: 0o700 });
  try {
    const localized = pageId === "achievement/achievement";
    const indexOnly = localized || pageId === "monstervalue" || isMonsterGroupPage(pageId);
    const sourceLocale = localized ? locale : null;
    const localeMode = localized ? "path" : "embedded";
    const sourcePath = `${version}/${localized ? locale + "/" : ""}${pageId}.json`;
    const sourceUrl = `${atlasSourceOrigin}/${game}/${sourcePath}`;
    const index = await sourceJson(sourceUrl, false, active, request, indexOnly ? maxLargeIndexBytes : maxJsonBytes);
    const entries = category === "zzz/boss" ? bossSourceIndex(index, pages[category].maxRecords)
      : category === "zzz/shiyu" ? shiyuSourceIndex(index, pages[category].maxRecords)
      : sourceIndex(category, index);
    if (localized) readAchievementCategories(game, { version, sourceUrl,
      sources: entries.map(({ id, name, list }) => ({ id, name, list })) });
    if (scope.recordCount !== undefined && entries.length !== scope.recordCount) throw new Error(`${folder}来源条目数与计划不符。`);
    await mkdir(join(data, items), { recursive: true });
    const records: Record<string, unknown> = {};
    const images = new Map<string, Awaited<ReturnType<typeof readIcon>>>();
    const loadIcon = async (name: string, paths: readonly string[] = [name]) => {
      if (!images.has(name)) images.set(name, await readIcon(name, paths, category, target, active, request));
      return images.get(name);
    };
    let usedPlaceholder = false;
    const legacyMissing = new Set<string>();
    for (const entry of entries) {
      const { id, name, rarity, list } = entry;
      const detailUrl = `${atlasSourceOrigin}/${game}/${version}/${locale}/${pageId}/${id}.json`;
      const detail = indexOnly ? undefined : await sourceJson(detailUrl, pageId === "bangboo", active, request);
      const hasDetail = detail !== undefined;
      const detailSourceUrl = hasDetail ? detailUrl : null;
      const references = [];
      if ("begin" in entry || "priority" in entry) {
        const challengeImages = "priority" in entry ? shiyuSourceImages(detail, entry) : bossSourceImages(detail, entry);
        for (const image of challengeImages) {
          const { fieldPath, originalValue, candidates } = image;
          let icon: Awaited<ReturnType<typeof readIcon>>;
          for (const candidate of candidates) {
            icon = await loadIcon(candidate);
            if (icon) break;
          }
          if (!icon) {
            if ("legacyMissing" in image && image.legacyMissing) {
              legacyMissing.add(originalValue);
              continue;
            }
            const mode = "priority" in entry ? "式舆" : "危局";
            throw new Error(`${mode}来源原图缺失（${id}，${fieldPath}）。`);
          }
          references.push(imageReference(fieldPath, originalValue, icon));
        }
      } else {
        if (detail !== undefined && !detailMatches(category, detail, entry)) {
          if (category === "zzz/equipment") throw new Error(`驱动盘详情与来源索引不符或缺少套装故事（${id}）。`);
          throw new Error(`${folder}详情与来源索引身份或等级不符（${id}）。`);
        }
        const { iconName, pathName } = entry;
        if (category === "zzz/character") {
          for (const { fieldPath, originalValue, candidates, required } of zzzCharacterImages(id, list, detail)) {
            let artwork: Awaited<ReturnType<typeof readIcon>>;
            for (const candidate of candidates) {
              artwork = await loadIcon(candidate);
              if (artwork) break;
            }
            if (!artwork && required) throw new Error(`绝区零角色来源原图缺失（${id}，${fieldPath}）。`);
            if (artwork) references.push(imageReference(fieldPath, originalValue, artwork));
          }
        } else if (pathName) {
          const artName = `lightconemediumicon/${id}`;
          const art = await loadIcon(artName);
          if (!art) throw new Error(`光锥来源原图缺失（${id}）。`);
          const pathIconName = `pathicon/${pathName}`;
          const pathIcon = await loadIcon(pathIconName);
          if (!pathIcon) throw new Error(`光锥来源命途图标缺失（${id}）。`);
          references.push(imageReference("derived.lightConeMediumIcon", artName, art),
            imageReference("derived.path", pathIconName, pathIcon),
            imageReference("detail.derived.lightConeMediumIcon", artName, art));
        } else if (iconName) {
          const iconFolder = category === "zzz/bangboo" ? bangbooImages : category === "zzz/weapon" ? weaponImages : undefined;
          const icon = await loadIcon(iconName, iconFolder ? [iconName, `${iconFolder}/${iconName}`] : [iconName]);
          if (!icon && (category === "zzz/weapon" || category === "zzz/equipment")) throw new Error(`${folder}来源图标缺失（${id}）。`);
          if (!icon && category === "gi/artifact" && !missingGenshinArtifactIcons.get(id)?.has(iconName)) {
            throw new Error(`原神圣遗物来源主图缺失（${id}）。`);
          }
          if (!icon && category === "hsr/monster") throw new Error(`星铁敌人来源原图缺失（${id}）。`);
          if (!icon && category === "hsr/relicset") throw new Error(`星铁遗器来源图标缺失（${id}）。`);
          if (!icon && localized) throw new Error(`${folder}来源图标缺失（${id}）。`);
          if (!icon && category === "gi/weapon" && genshinMissingIcons.get(id) !== iconName) {
            throw new Error(`原神武器来源图标缺失（${id}）。`);
          }
          references.push(imageReference("icon", list.icon, icon));
          usedPlaceholder ||= !icon;
          const { icon: detailIcon, icon2 } = object(detail);
          if (typeof detailIcon === "string" && (pageId === "weapon" || detailIcon === list.icon)) {
            references.push(imageReference("detail.icon", detailIcon, icon));
          }
          if (category === "hsr/monster") {
            const { image_path } = object(detail);
            references.push(imageReference("derived.monsterFigure", iconName, icon),
              imageReference("detail.image_path", image_path, icon));
          }
          if (category === "gi/artifact") {
            for (const [slot, part] of Object.entries(object(object(detail).parts))) {
              const name = object(part).icon as string;
              const artwork = await loadIcon(name);
              if (!artwork && !missingGenshinArtifactIcons.get(id)?.has(name)) {
                throw new Error(`原神圣遗物来源部位图缺失（${id}，${slot}）。`);
              }
              usedPlaceholder ||= !artwork;
              references.push(imageReference(`detail.parts.${slot}.icon`, name, artwork));
            }
          }
          if (category === "zzz/equipment") references.push(imageReference("detail.icon2", icon2, icon));
        }
      }
      const path = `${items}/${id}.json`;
      const metadata = { sourceUrl, sourcePath, sourceLocale, localeMode, detailSourceUrl };
      await writeJson(join(data, path), { meta: { ...metadata, gameId: game, pageId, locale,
        recordId: id, name, version, rarity, hasDetail, images: references }, content: { list, detail: detail ?? null } });
      records[id] = { id, name, rarity, path, hasDetail, detailSourceUrl, imageCount: references.length };
    }
    if (usedPlaceholder) {
      await mkdir(join(target, "gallery", "_placeholder"), { recursive: true });
      await writeFile(join(target, placeholderPath), placeholder, { flag: "wx" });
    }
    const page = { id: pageId, title, folder, sourceUrl, sourcePath, sourceLocale,
      localeMode, version, recordCount: entries.length, totalRecordCount: entries.length, sampled: false, records };
    await writeJson(join(data, "map.json"), {
      meta: { source: "https://nanoka.cc/", locales: [locale], imageDownloads: true,
        requestedVersions: { [game]: version }, selectedPages: { [game]: [pageId] } },
      games: { [game]: { game: { id: game, versions: [version], requestedVersion: version },
        locales: { [locale]: { pages: { [pageId]: page } } } } },
    });
    const validation = await validateAtlasCandidate(data, requirements, active);
    if (!validation.ok) throw new Error(`抓取的源快照未通过校验。${validation.issues[0] ?? ""}`);
    const imageCount = [...images.values()].filter((image) => image !== undefined).length;
    const missingImageCount = publishedChallenge ? legacyMissing.size : images.size - imageCount;
    return { directory: target, pages: validation.pages, imageCount, missingImageCount };
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}
