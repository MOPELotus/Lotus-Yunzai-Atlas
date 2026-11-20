import { createHash } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { branchAndBladeIcon, effectText, label, object } from "./source-values.ts";
import { readAchievementCategories } from "./achievements.ts";
import { bossSourceImages, bossSourceIndex } from "./boss-source-data.ts";
import { shiyuSourceImages, shiyuSourceIndex } from "./shiyu-source-data.ts";
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
  "zzz/bangboo": { game: "zzz", pageId: "bangboo", title: "Bangboo", folder: "邦布", timeout: 180_000, maxRecords: 256 },
  "zzz/weapon": { game: "zzz", pageId: "weapon", title: "Weapon", folder: "音擎", timeout: 180_000, maxRecords: 256 },
  "zzz/equipment": { game: "zzz", pageId: "equipment", title: "Drive Disc", folder: "驱动盘", timeout: 180_000, maxRecords: 256 },
  "hsr/lightcone": { game: "hsr", pageId: "lightcone", title: "Light Cone", folder: "光锥", timeout: 360_000, maxRecords: 256 },
  "zzz/achievement/achievement": { game: "zzz", pageId: "achievement/achievement", title: "Achievement", folder: "绝区零成就", timeout: 60_000, maxRecords: 3 },
  "gi/achievement/achievement": { game: "gi", pageId: "achievement/achievement", title: "Achievement", folder: "原神成就", timeout: 180_000, maxRecords: 256 },
  "hsr/achievement/achievement": { game: "hsr", pageId: "achievement/achievement", title: "Achievement", folder: "星铁成就", timeout: 60_000, maxRecords: 256 },
  "gi/weapon": { game: "gi", pageId: "weapon", title: "Weapon", folder: "武器", timeout: 600_000, maxRecords: 512 },
  "zzz/boss": { game: "zzz", pageId: "boss", title: "Deadly Assault", folder: "危局强袭战", timeout: 360_000, maxRecords: 256 },
  "zzz/shiyu": { game: "zzz", pageId: "shiyu", title: "Shiyu Defense", folder: "式舆防卫战", timeout: 360_000, maxRecords: 256 },
} as const;
type SourcePage = keyof typeof pages;
const maxJsonBytes = 1024 * 1024;
const maxAchievementIndexBytes = 2 * 1024 * 1024;
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
  const bytes = await readAtlasSourceBytes(url, "application/json", limit, optional, signal, request);
  return bytes === undefined ? undefined : JSON.parse(utf8.decode(bytes)) as unknown;
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { flag: "wx" });
}

function sourceIndex(category: SourcePage, value: unknown) {
  const entries = Object.entries(object(value));
  const { folder, maxRecords } = pages[category];
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
    if (!/^[1-9]\d{0,9}$/u.test(id) || typeof zh !== "string" || !zh.trim()) throw new Error(`${folder}来源索引条目结构无效。`);
    const name = zh.trim();
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

function detailMatches(category: SourcePage, detail: unknown, entry: ReturnType<typeof sourceIndex>[number]) {
  const { id, name, rank, iconName, list } = entry;
  const item = object(detail);
  if (typeof item.name !== "string" || item.name.trim() !== name) return false;
  if (category === "hsr/lightcone") return lightconeDetail(item, id, list);
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
    const bytes = await readAtlasSourceBytes(remoteUrl, "image/webp", maxIconBytes, true, signal, request);
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
    const sourceLocale = localized ? locale : null;
    const localeMode = localized ? "path" : "embedded";
    const sourcePath = `${version}/${localized ? locale + "/" : ""}${pageId}.json`;
    const sourceUrl = `${atlasSourceOrigin}/${game}/${sourcePath}`;
    const index = await sourceJson(sourceUrl, false, active, request, localized ? maxAchievementIndexBytes : maxJsonBytes);
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
      const detail = localized ? undefined : await sourceJson(detailUrl, pageId === "bangboo", active, request);
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
        if (pathName) {
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
