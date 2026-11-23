import type { Character, Game } from "./catalog.ts";
import { effectText, galleryArtwork, label, object } from "./source-values.ts";
import { zzzFullNames } from "./zzz-role-names.ts";

export interface RoleText {
  readonly label?: string;
  readonly text: string;
}

export interface RoleSkillLevel {
  readonly level: number;
  readonly sourceId?: string;
  readonly description?: string;
  readonly details: readonly RoleText[];
}

export interface RoleSkillCard {
  readonly name: string;
  readonly description?: string;
  readonly artwork?: string;
  readonly details: readonly RoleText[];
  readonly levels?: readonly RoleSkillLevel[];
  readonly sectionLevels?: readonly RoleSkillLevel[];
  readonly sectionDescription?: string;
  readonly sectionParameters?: readonly { label: string; values: readonly { level: number; value: number }[] }[];
  readonly omitFromSection?: boolean;
  readonly memospriteIcon?: "me" | "mt";
  readonly linkedEffects?: readonly RoleSkillCard[];
  readonly sectionVariants?: readonly RoleSkillCard[];
  readonly sectionVariantTitle?: string;
}

export interface RoleSkillGroup {
  readonly title: string;
  readonly cards: readonly RoleSkillCard[];
}

export interface RoleRank {
  readonly rank: number;
  readonly name: string;
  readonly description?: string;
  readonly story?: string;
  readonly artwork?: string;
}

export interface RoleMaterialItem {
  readonly id?: string;
  readonly name?: string;
  readonly count: number;
  readonly artwork?: string;
}

export interface RoleMaterialGroup {
  readonly title: string;
  readonly items: readonly RoleMaterialItem[];
  readonly cost?: number;
}

export interface RoleDetails {
  readonly game: Game;
  readonly id: string;
  readonly version: string;
  readonly overview: {
    readonly name: string;
    readonly rarity: string;
    readonly description?: string;
    readonly artwork?: string;
    readonly icon?: string;
    readonly portraitFallbacks?: readonly string[];
    readonly iconFallback?: string;
    readonly element?: GenshinElement;
    readonly traveler?: GenshinTraveler;
    readonly facts: readonly { label: string; value: string }[];
    readonly stats?: readonly { label: string; value: string }[];
    readonly sectionStats?: {
      readonly level: number;
      readonly rows: readonly { label: string; value: string }[];
    };
  };
  readonly skills: readonly RoleSkillGroup[];
  readonly sectionSkills?: readonly RoleSkillGroup[];
  readonly ranks: readonly RoleRank[];
  readonly materials: readonly RoleMaterialGroup[];
}

type RecordValue = Record<string, unknown>;
type Artwork = (...fields: string[]) => string | undefined;

const genshinElements = {
  Pyro: "pyro", Hydro: "hydro", Anemo: "anemo", Cryo: "cryo", Geo: "geo", Electro: "electro", Dendro: "dendro",
} as const;
type GenshinElement = typeof genshinElements[keyof typeof genshinElements];

function genshinElement(list: RecordValue, detail: RecordValue): GenshinElement | undefined {
  const code = label(detail.element);
  if (code !== label(list.element) || !Object.hasOwn(genshinElements, code)) return;
  return genshinElements[code as keyof typeof genshinElements];
}

const starRailPaths: Readonly<Record<string, string>> = {
  Warrior: "毁灭", Rogue: "巡猎", Mage: "智识", Warlock: "虚无", Shaman: "同谐", Knight: "存护", Priest: "丰饶", Memory: "记忆", Elation: "欢愉",
};
const starRailElements: Readonly<Record<string, string>> = {
  Physical: "物理", Fire: "火", Ice: "冰", Thunder: "雷", Wind: "风", Quantum: "量子", Imaginary: "虚数",
};
const zenlessSkills: Readonly<Record<string, string>> = {
  basic: "普通攻击", dodge: "闪避", special: "特殊技", chain: "连携技与终结技", assist: "支援技",
};
const zenlessButtons: Readonly<Record<string, string>> = {
  Icon_Normal: "普通攻击", Icon_Evade: "闪避", Icon_Evaded: "闪避反击", Icon_Special: "特殊技",
  Icon_SpecialReady: "强化特殊技", Icon_SpecialReady_Rp: "强化特殊技", Icon_UltimateReady: "终结技",
  Icon_Switch: "切换", Icon_QTE: "快速支援", Icon_Chain: "连携技", Icon_Assist: "支援技", Icon_CoreSkill: "核心技",
};
export const genshinRolePortraitFields = ["derived.avatarGacha", "detail.derived.avatarGacha", "derived.avatarBust", "detail.derived.avatarBust",
    "derived.avatarDrawCard", "detail.derived.avatarDrawCard", "detail.gacha", "gacha", "detail.bust", "bust",
    "detail.portrait", "portrait"] as const;
const focusFields = {
  gi: genshinRolePortraitFields,
  hsr: ["derived.avatarDrawCard", "detail.derived.avatarDrawCard", "detail.portrait", "portrait"],
  zzz: ["derived.avatarDrawCard", "detail.derived.avatarDrawCard", "detail.portrait", "portrait", "detail.partner_info.role_icon"],
} as const;

const wholeStat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const decimalStat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const percentStat = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });

function rows(value: unknown): [string, RecordValue][] {
  return Object.entries(object(Array.isArray(value) ? { ...value } : value))
    .flatMap(([key, value]) => {
      const record = object(value);
      return Object.keys(record).length ? [[key, record]] : [];
    });
}

function values(value: unknown): RecordValue[] {
  return rows(value).map(([, row]) => row);
}

function integer(value: unknown): number | undefined {
  const number = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof number === "number" && Number.isSafeInteger(number) && number > 0) return number;
}

function identifier(value: unknown): string | undefined {
  const id = typeof value === "number" ? String(value) : label(value);
  if (/^[1-9]\d*$/u.test(id) && integer(id)) return id;
}

function text(value: unknown, params?: unknown): string | undefined {
  const clean = label(value).replace(/<IconMap:([\w]+)>/gu, (_, key: string) => `〔${label(zenlessButtons[key]) || key}〕`)
    .replace(/<\/?(?:b|i)>/giu, "");
  return effectText(clean, Array.isArray(params) ? params : undefined, true) || undefined;
}

function skillGroup(title: string, cards: RoleSkillCard[]): RoleSkillGroup[] {
  return cards.length ? [{ title, cards }] : [];
}

function sectionLevelRange(levels: readonly RoleSkillLevel[], min: number, max: number) {
  return levels.filter(({ level }) => level >= min && level <= max);
}

function genshinNumbers(value: string, params: unknown): string | undefined {
  const numbers = Array.isArray(params) ? params : [];
  const resolved = value.replace(/\{param(\d+):(I|P|F[0-4]P?)\}/gu, (source, index, format: string) => {
    const number = numbers[Number(index) - 1];
    if (typeof number !== "number" || !Number.isFinite(number)) return source;
    const percent = format.endsWith("P");
    const digits = format[0] === "F" ? Number(format[1]) : 0;
    return (number * (percent ? 100 : 1)).toFixed(digits) + (percent ? "%" : "");
  });
  if (!/\{param\d+:/u.test(resolved)) return text(resolved);
}

function genshinSkills(detail: RecordValue, artwork: Artwork): RoleSkillGroup[] {
  const skills = rows(detail.skills).flatMap(([key, skill]) => {
    const name = text(skill.name);
    if (!name) return [];
    const levels = values(skill.promote).flatMap((row) => {
      const level = integer(row.level);
      if (!level || !Array.isArray(row.desc)) return [];
      const details = row.desc.flatMap((value) => {
        const source = label(value);
        const separator = source.indexOf("|");
        const result = genshinNumbers(separator < 0 ? source : source.slice(separator + 1), row.param);
        return result ? [{ label: separator < 0 ? undefined : label(source.slice(0, separator)), text: result }] : [];
      });
      return details.length ? [{ level, details }] : [];
    });
    return [{ name, description: text(skill.desc), details: [], levels, sectionLevels: sectionLevelRange(levels, 6, 13),
      artwork: artwork(`detail.skills.${key}.icon`, `detail.skills.${key}.promote.0.icon`) }];
  });
  const passives = rows(detail.passives).flatMap(([key, passive]) => {
    const name = text(passive.name);
    return name ? [{ name, description: text(passive.desc, passive.param_list), details: [],
      artwork: artwork(`detail.passives.${key}.icon`) }] : [];
  });
  const echoes = rows(object(detail.chara_info).trace_effect ?? detail.trace_effect).flatMap(([key, echo]) => {
    const name = text(echo.name);
    return name ? [{ name, description: text(echo.desc), details: [], artwork: artwork(`detail.chara_info.trace_effect.${key}.icon`) }] : [];
  });
  return [...skillGroup("战斗天赋", skills), ...skillGroup("固有天赋", passives), ...skillGroup("绘想游迹", echoes)];
}

function starRailSectionSkill(template: unknown, source: readonly RecordValue[], basic: boolean,
  sourceLevels: readonly RoleSkillLevel[]): Pick<RoleSkillCard, "sectionDescription" | "sectionLevels" | "sectionParameters"> {
  const raw = label(template);
  const marker = /#(\d+)\[(i|f[0-4])\](%?)/gu;
  const markers = [...new Map([...raw.matchAll(marker)].map((entry) => [entry[0], entry])).values()];
  if (!markers.length) return { sectionLevels: sectionLevelRange(sourceLevels, basic ? 1 : 6, basic ? 7 : 12) };
  const levels = source.flatMap((data) => {
    const level = integer(data.level);
    return level && Array.isArray(data.param_list) ? [{ level, params: data.param_list as readonly unknown[] }] : [];
  });
  const target = levels.find(({ level }) => level === (basic ? 5 : 8)) ?? levels[0];
  if (!target) return { sectionLevels: [] };
  const selected = levels.filter(({ level }) => basic ? level >= 1 && level <= 7 : level >= 6 && level <= 12);
  const displayed = selected.map(({ level }) => ({ level, details: [] as RoleText[] }));
  const display = new Map<string, string>();
  const sectionParameters: NonNullable<RoleSkillCard["sectionParameters"]>[number][] = [];
  for (const [token, index, format, percent] of markers) {
    const key = Number(index) - 1;
    const scalar = number(target.params[key]);
    if (scalar === undefined) return { sectionLevels: [] };
    const precision = format === "i" ? 0 : Number(format?.slice(1) ?? 0);
    const print = (value: number) => {
      if (percent) return (value * 100).toFixed(Math.max(1, precision)) + "%";
      return format === "i" ? wholeStat.format(value) : value.toFixed(precision);
    };
    const variable = levels.some(({ params }) => number(params[key]) !== scalar);
    display.set(token, `${print(scalar)}${variable ? ` (Lv${target.level})` : ""}`);
    if (!variable) continue;
    const values = selected.flatMap(({ level, params }) => {
      const value = number(params[key]);
      return value === undefined ? [] : [{ level, value }];
    });
    if (values.length !== selected.length || !values.length) continue;
    const row = `正文第 ${sectionParameters.length + 1} 项`;
    sectionParameters.push({ label: row, values });
    for (const [i, { value }] of values.entries()) {
      displayed[i]!.details.push({ label: row, text: print(value) });
    }
  }
  const sectionDescription = text(raw.replace(marker, (token) => display.get(token) ?? token));
  return { sectionDescription, sectionLevels: displayed, sectionParameters };
}

function starRailSkillCard(skill: RecordValue, artwork?: string): RoleSkillCard | undefined {
  const name = text(skill.name);
  if (!name) return;
  const sourceLevels = values(skill.level);
  const levels = sourceLevels.flatMap((row) => {
    const level = integer(row.level);
    const description = text(skill.desc, row.param_list);
    return level && description ? [{ level, description, details: [] }] : [];
  });
  const type = text(skill.type_name);
  const basic = /^(?:普攻|普通攻击|忆灵技|忆灵天赋)$/u.test(type ?? "");
  const omitFromSection = label(skill.type) === "MazeNormal" || (!type && (integer(skill.id) ?? 0) % 100 === 6);
  return { name, description: text(skill.simple_desc) ?? levels[0]?.description ?? text(skill.desc),
    details: type ? [{ label: "类型", text: type }] : [], levels, omitFromSection,
    ...starRailSectionSkill(skill.desc, sourceLevels, basic, levels), artwork };
}

// In the fixed original character sheets these source slots map to me/me2, then mt/mt1/mt2.
// The variant attack uses 02 or 07; slots 13 and later are separate linked effects.
const memospriteSectionSlots = [
  ["01", "忆灵技", "me"], [["02", "07"], "忆灵技", undefined],
  ["03", "忆灵天赋", "mt"], ["05", "忆灵天赋", undefined], ["06", "忆灵天赋", undefined],
] as const;

function memospriteCard(skill: RecordValue, artwork?: string) {
  const clean = (value: unknown) => label(value).replace(/<\/?icon(?:\s[^<>\r\n]{0,160})?\s*\/?>/giu, "");
  const desc = clean(skill.desc);
  const card = starRailSkillCard({ ...skill, desc, simple_desc: clean(skill.simple_desc) }, artwork);
  return card && { ...card, sectionDescription: card.sectionDescription ?? text(desc),
    sectionLevels: card.sectionParameters?.length ? card.sectionLevels : [] };
}

function cyrenePoemEffects(skills: RecordValue): RoleSkillCard[] {
  // The fixed original template lists the fourteen effects by source ID, beneath the second memosprite skill.
  return Array.from({ length: 14 }, (_, index) => object(skills[String(1_141_513 + index)])).flatMap(skill => {
    if (label(skill.type_name) !== "忆灵技" || !integer(object(skill.link).link_avatar) || !/^献予「[^」]+」之诗$/u.test(label(skill.name))) return [];
    const card = memospriteCard(skill);
    return card ? [card] : [];
  });
}

function starRailMemospriteCards(id: string, detail: RecordValue, artwork: Artwork): RoleSkillCard[] {
  const companion = object(detail.memosprite);
  const skills = object(companion.skills);
  if (!Object.keys(skills).length) return [];
  // The male and female Trailblazers share the same Remembrance companion skill IDs.
  const owners = id === "8008" ? [id, "8007"] : [id];
  return memospriteSectionSlots.flatMap(([slot, type, memospriteIcon]) => {
    const suffixes = typeof slot === "string" ? [slot] : slot;
    const keys = owners.flatMap(owner => suffixes.map(suffix => `1${owner}${suffix}`));
    const key = keys.find(candidate => label(object(skills[candidate]).type_name) === type);
    if (!key) return [];
    const skill = object(skills[key]);
    const card = memospriteCard(skill,
      artwork(`detail.memosprite.skills.${key}.icon`, ...(memospriteIcon ? ["detail.memosprite.icon"] : [])));
    if (!card) return [];
    const linkedEffects = key === "1141502" && skill.exclusive === true ? cyrenePoemEffects(skills) : undefined;
    return [{ ...card, memospriteIcon, linkedEffects }];
  });
}

type StarRailActiveCard = { id: number | undefined; kind: string; card: RoleSkillCard };

const starRailSkillTypes: Readonly<Record<string, string>> = {
  Normal: "普攻", BPSkill: "战技", Ultra: "终结技", Talent: "天赋", Maze: "秘技", Assist: "助战技",
};

function starRailSkillKind(skill: RecordValue) {
  const type = label(skill.type);
  if (type === "MazeNormal") return "";
  const name = label(skill.type_name);
  if (name) return name === "普通攻击" ? "普攻" : name;
  return Object.hasOwn(starRailSkillTypes, type) ? starRailSkillTypes[type]! : "";
}

function starRailSectionCards(id: string, skills: readonly StarRailActiveCard[], trees: readonly [string, RecordValue][]) {
  const active = skills.filter(({ kind }) => kind);
  const byId = new Map(active.flatMap(skill => skill.id === undefined ? [] : [[skill.id, skill] as const]));
  const parents = new Map<number, RoleSkillCard[]>();
  const booked = new Set<number>();
  const group = (base: number, ids: readonly number[]) => {
    const family = [base, ...ids];
    if (family.some(value => booked.has(value))) return;
    const main = byId.get(base);
    if (!main || !ids.length) return;
    const variants = ids.flatMap(value => {
      const entry = byId.get(value);
      return entry?.kind === main.kind ? [entry.card] : [];
    });
    if (variants.length !== ids.length) return;
    parents.set(base, variants);
    for (const value of family) booked.add(value);
  };
  for (const [, tree] of trees) {
    const point = values(tree).find(row => row.point_type === 2 && Array.isArray(row.level_up_skill_id));
    const ids = point?.level_up_skill_id;
    if (!Array.isArray(ids)) continue;
    const [base, ...variants] = [...new Set(ids.flatMap(value => integer(value) ?? []))];
    if (base !== undefined) group(base, variants);
  }
  // The archived character's e2 is the cancel action of his enhancement skill, without a level-up tree entry.
  if (id === "1213" && byId.get(121309)?.card.name === "取消") group(121302, [121309]);
  const covered = new Set([...booked].filter(value => !parents.has(value)));
  return active.flatMap(({ id: sourceId, card }) => {
    if (sourceId === undefined) return [card];
    if (covered.has(sourceId)) return [];
    const sectionVariants = parents.get(sourceId);
    return sectionVariants ? [{ ...card, sectionVariants,
      sectionVariantTitle: id === "1213" && sourceId === 121301 ? "强化普攻" : undefined,
    }] : [card];
  });
}

function starRailSkills(id: string, detail: RecordValue, artwork: Artwork) {
  const groups = rows(detail.skill_trees);
  const activeCards = rows(detail.skills).flatMap(([key, skill]) => {
    const source = groups.flatMap(([point, group]) => rows(group).flatMap(([key, row]) =>
      Array.isArray(row.level_up_skill_id) && row.level_up_skill_id.includes(skill.id)
        ? [`detail.skill_trees.${point}.${key}.icon`] : []));
    const card = starRailSkillCard(skill, artwork(`detail.skills.${key}.icon`, ...source));
    return card ? [{ id: integer(skill.id) ?? integer(key), kind: starRailSkillKind(skill), card }] : [];
  });
  const traces = groups.flatMap(([point, group]) => {
    const data = rows(group).filter(([, row]) => row.point_type === 1 || row.point_type === 3);
    const first = data[0];
    if (!first) return [];
    const name = text(first[1].point_name);
    if (!name) return [];
    const levels = data.flatMap(([key, row]) => {
      const level = integer(key);
      const description = text(row.point_desc, row.param_list);
      const details = values(row.status_add_list).flatMap(({ name, value, property_type }) => {
        const title = text(name);
        if (!title || typeof value !== "number" || !Number.isFinite(value)) return [];
        const percent = /Ratio$|^(?:StatusProbabilityBase|StatusResistanceBase|CriticalChanceBase|CriticalDamageBase)$/u.test(label(property_type));
        const display = percent ? `${Number((value * 100).toFixed(6))}%` : String(value);
        return [{ label: title, text: display }];
      });
      return level && (description || details.length) ? [{ level, description, details }] : [];
    });
    return [{ name, description: levels[0]?.description, details: levels[0]?.details ?? [], levels, sectionLevels: [],
      omitFromSection: first[1].point_type === 1, artwork: artwork(`detail.skill_trees.${point}.${first[0]}.icon`) }];
  });
  const active = skillGroup("技能", activeCards.map(({ card }) => card));
  const passive = skillGroup("行迹", traces);
  const memosprite = starRailMemospriteCards(id, detail, artwork);
  return {
    skills: [...active, ...passive],
    sectionSkills: [...skillGroup("技能", starRailSectionCards(id, activeCards, groups)), ...skillGroup("忆灵技能", memosprite), ...passive],
  };
}

function zenlessNumbers(entry: RecordValue, levelNumbers: readonly number[]): RoleSkillLevel[] {
  const parameters = values(entry.param).flatMap((parameter) => {
    const name = text(parameter.name);
    if (!name) return [];
    const ranges = values(parameter.param);
    return ranges.flatMap(({ main, growth, format }, index) => {
      if (typeof main !== "number" || !Number.isFinite(main)) return [];
      return [{ label: ranges.length > 1 ? `${name} ${index + 1}` : name, main,
        growth: typeof growth === "number" && Number.isFinite(growth) ? growth : undefined, percent: label(format).includes("%") }];
    });
  });
  if (!parameters.length) return [];
  return levelNumbers.flatMap((level) => {
    const details = parameters.flatMap(({ label, main, growth, percent }) => {
      if (level > 1 && growth === undefined) return [];
      const number = main + (growth ?? 0) * (level - 1);
      const scaled = percent ? number / 100 : number;
      return Number.isFinite(scaled) ? [{ label, text: `${Number(scaled.toFixed(6))}${percent ? "%" : ""}` }] : [];
    });
    return details.length ? [{ level, details }] : [];
  });
}

function zenlessSkillsAndCores(detail: RecordValue, artwork: Artwork): RoleSkillGroup[] {
  const skills = rows(detail.skill).flatMap(([key, skill]) => {
    const levelNumbers = [1, ...Object.keys(object(skill.material)).flatMap((key) => {
      const level = integer(key);
      return level && level > 1 ? [level] : [];
    })];
    const cards = rows(skill.description).flatMap(([index, entry]) => {
      const name = text(entry.name);
      const description = text(entry.desc, entry.param_list);
      return name ? [{ name, description, details: [], levels: zenlessNumbers(entry, levelNumbers),
        artwork: artwork(`detail.skill.${key}.description.${index}.icon`) }] : [];
    });
    return skillGroup(label(zenlessSkills[key]) || text(skill.name) || "技能", cards);
  });
  const cores = new Map<string, RoleSkillLevel[]>();
  for (const [sourceId, row] of rows(object(detail.passive).level)) {
    const level = integer(row.level);
    if (!level || !Array.isArray(row.name) || !Array.isArray(row.desc)) continue;
    const descriptions = row.desc;
    for (const [index, value] of row.name.entries()) {
      const name = text(value);
      const description = text(descriptions[index]);
      if (!name || !description) continue;
      const levels = cores.get(name) ?? [];
      levels.push({ level, sourceId, description, details: [] });
      cores.set(name, levels);
    }
  }
  return [...skills, ...skillGroup("核心能力", [...cores].map(([name, levels]) => ({ name, details: [], levels })))];
}

function ranksFor(game: Game, detail: RecordValue, artwork: Artwork): RoleRank[] {
  const zenlessSource = values(detail.talent).length ? "talent" : "potential_detail";
  const field = game === "gi" ? "constellations" : game === "hsr" ? "ranks" : zenlessSource;
  const found = new Map<number, RoleRank>();
  for (const [key, value] of rows(detail[field])) {
    const rank = game === "gi" ? Number(key) + 1 : integer(value.level ?? key);
    const name = text(value.name);
    if (!rank || !Number.isInteger(rank) || rank < 1 || rank > 6 || !name || found.has(rank)) continue;
    found.set(rank, { rank, name, description: text(value.desc, value.param_list ?? value.param), story: text(value.desc2),
      artwork: artwork(`detail.${field}.${key}.icon`, `detail.${field}.${key}.image`, `detail.derived.mindscape.${rank}`) });
  }
  return [...found.values()];
}

function mergeMaterials(items: readonly RoleMaterialItem[]): RoleMaterialItem[] {
  const merged = new Map<string, RoleMaterialItem>();
  for (const item of items) {
    const key = item.id ?? item.name;
    if (!key) continue;
    const previous = merged.get(key);
    if (!previous) merged.set(key, item);
    else if (Number.isSafeInteger(previous.count + item.count)) {
      merged.set(key, { ...previous, name: previous.name ?? item.name, artwork: previous.artwork ?? item.artwork,
        count: previous.count + item.count });
    }
  }
  return [...merged.values()];
}

function materialsGroup(title: string, items: RoleMaterialItem[], cost?: number): RoleMaterialGroup[] {
  return items.length || cost ? [{ title, items: mergeMaterials(items), cost }] : [];
}

function genshinMaterials(detail: RecordValue, artwork: Artwork): RoleMaterialGroup[] {
  const materials = object(detail.materials);
  const groups: RoleMaterialGroup[] = [];
  function collect(title: string, value: unknown, prefix: string) {
    const items: RoleMaterialItem[] = [];
    let cost = 0;
    for (const [stage, data] of rows(value)) {
      const stageCost = integer(data.cost) ?? 0;
      if (Number.isSafeInteger(cost + stageCost)) cost += stageCost;
      for (const [index, row] of rows(data.mats)) {
        const id = identifier(row.id);
        const name = text(row.name);
        const count = integer(row.count);
        if (count && (id || name)) items.push({ id, name, count, artwork: artwork(`${prefix}.${stage}.mats.${index}.icon`) });
      }
    }
    groups.push(...materialsGroup(title, items, cost || undefined));
  }
  collect("角色突破材料", materials.ascensions, "detail.materials.ascensions");
  const talents = Array.isArray(materials.talents) ? materials.talents : object(materials.talents);
  for (const [key, tree] of Object.entries(talents)) {
    const skillName = Array.isArray(detail.skills) ? text(object(detail.skills[Number(key)]).name) : undefined;
    collect(skillName ? `${skillName}升级材料` : "天赋升级材料", tree, `detail.materials.talents.${key}`);
  }
  return groups;
}

function starRailMaterials(detail: RecordValue): RoleMaterialGroup[] {
  const read = (value: unknown) => values(value).flatMap((row) => {
    const id = identifier(row.item_id);
    const count = integer(row.item_num);
    return id && count ? [{ id, count }] : [];
  });
  return [
    ...materialsGroup("角色晋阶材料", values(detail.stats).flatMap((row) => read(row.cost))),
    ...materialsGroup("行迹材料", values(detail.skill_trees).flatMap((group) => values(group).flatMap((row) => read(row.material_list)))),
  ];
}

function zenlessMaterials(detail: RecordValue): RoleMaterialGroup[] {
  const read = (value: unknown) => Object.entries(object(value)).flatMap(([key, value]) => {
    const id = identifier(key);
    const count = integer(value);
    return id && count ? [{ id, count }] : [];
  });
  return [
    ...materialsGroup("角色晋阶材料", values(detail.level).flatMap((row) => read(row.materials))),
    ...rows(detail.skill).flatMap(([key, skill]) => materialsGroup(`${label(zenlessSkills[key]) || "技能"}升级材料`,
      values(skill.material).flatMap(read))),
    ...materialsGroup("核心技升级材料", values(object(detail.passive).materials).flatMap(read)),
    ...materialsGroup("潜能材料", values(detail.potential_detail).flatMap((row) => values(row.potential_materials).flatMap((item) => {
      const id = identifier(item.item_id);
      const count = integer(item.number);
      return id && count ? [{ id, count }] : [];
    }))),
  ];
}

function overviewFacts(game: Game, detail: RecordValue): RoleDetails["overview"]["facts"] {
  const info = object(detail.chara_info);
  const fields: [string, unknown][] = game === "gi"
    ? [["称号", info.title], ["地区", info.native], ["神之眼", info.vision], ["命之座", info.constellation]]
    : game === "hsr"
      ? [["阵营", info.camp], ["命途", starRailPaths[label(detail.base_type)]], ["属性", starRailElements[label(detail.damage_type)]]]
      : [["阵营", Object.values(object(detail.camp)).map(label).filter(Boolean).join("、")],
        ["特性", Object.values(object(detail.weapon_type)).map(label).filter(Boolean).join("、")],
        ["属性", Object.values(object(detail.element_type)).map(label).filter(Boolean).join("、")]];
  return fields.flatMap(([label, source]) => {
    const value = text(source);
    return value ? [{ label, value }] : [];
  });
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

type Stat = readonly [label: string, value: number | undefined, format?: Intl.NumberFormat];
type LevelStats = (typeof levelStats)[number];
const levelStats = ["生命", "攻击", "防御"] as const;

function levelPairs(high: number | undefined, calculate: (stat: LevelStats, high: boolean) => number | undefined): Stat[] {
  return levelStats.flatMap((stat) => [
    [`Lv1${stat}`, calculate(stat, false)] as const,
    ...(high === undefined ? [] : [[`Lv${high}${stat}`, calculate(stat, true)] as const]),
  ]);
}

const genshinBaseField = {
  生命: ["hp", "base_hp", "fight_prop_base_hp"],
  攻击: ["atk", "base_atk", "fight_prop_base_attack"],
  防御: ["def", "base_def", "fight_prop_base_defense"],
} as const;

function genshinBase(detail: RecordValue, modifiers: RecordValue, stat: LevelStats, level: number, ascension?: RecordValue) {
  const [curve, baseField, bonus] = genshinBaseField[stat];
  const base = number(detail[baseField]);
  const factor = number(object(modifiers[curve])[String(level)]);
  if (base !== undefined && factor !== undefined) return base * factor + (number(ascension?.[bonus]) ?? 0);
}

function genshinStats(detail: RecordValue): Stat[] {
  const modifiers = object(detail.stats_modifier);
  const ascension = values(modifiers.ascension).at(-1);
  const leveled = levelPairs(ascension ? 90 : undefined, (stat, high) =>
    genshinBase(detail, modifiers, stat, high ? 90 : 1, high ? ascension : undefined));
  function critical(baseField: string, bonusField: string) {
    const base = number(detail[baseField]);
    if (base !== undefined) return base + (number(ascension?.[bonusField]) ?? 0);
  }
  return [...leveled, ["暴击率", critical("crit_rate", "fight_prop_critical"), percentStat],
    ["暴击伤害", critical("crit_dmg", "fight_prop_critical_hurt"), percentStat]];
}

function starRailStats(detail: RecordValue): Stat[] {
  const stages = new Map(rows(detail.stats));
  const first = stages.get("0");
  // This source indexes the standard Lv80 final promotion as stage 6.
  const last = stages.get("6");
  const fields = { 生命: "hp", 攻击: "attack", 防御: "defence" } as const;
  const leveled = levelPairs(last ? 80 : undefined, (stat, high) => {
    const field = fields[stat];
    const base = number((high ? last : first)?.[`${field}_base`]);
    if (!high || base === undefined) return base;
    const growth = number(last?.[`${field}_add`]);
    if (growth !== undefined) return base + growth * 79;
  });
  const stats = last ?? first;
  return [...leveled, ["速度", number(stats?.speed_base), decimalStat],
    ["暴击率", number(stats?.critical_chance), percentStat], ["暴击伤害", number(stats?.critical_damage), percentStat]];
}

function zenlessStats(detail: RecordValue): Stat[] {
  const stats = object(detail.stats);
  const boundaries = values(detail.level).flatMap((row) => {
    const min = number(row.level_min);
    const max = integer(row.level_max);
    return min !== undefined && max !== undefined && min < max ? [{ row, min, max }] : [];
  });
  const low = boundaries.find(({ min, max }) => min <= 1 && max >= 1);
  const high = boundaries.reduce<(typeof boundaries)[number] | undefined>((current, candidate) =>
    current === undefined || candidate.max > current.max ? candidate : current, undefined);
  const fields = { 生命: ["hp_max", "hp_growth"], 攻击: ["attack", "attack_growth"], 防御: ["defence", "defence_growth"] } as const;
  const extras = values(detail.extra_level);
  const leveled = levelPairs(high?.max, (stat, atHigh) => {
    const stage = atHigh ? high : low;
    const level = atHigh ? stage?.max : 1;
    const [field, growthField] = fields[stat];
    const base = number(stats[field]);
    const promotion = number(stage?.row[field]);
    const growth = level === 1 ? 0 : number(stats[growthField]);
    if (base === undefined || promotion === undefined || growth === undefined || level === undefined) return;
    const extra = stat === "攻击" ? extras.find((row) => (integer(row.max_level) ?? 0) >= level) : undefined;
    const attack = number(object(object(extra?.extra)["12101"]).value) ?? 0;
    return base + growth / 10_000 * (level - 1) + promotion + attack;
  });
  const critical = number(stats.crit);
  const criticalDamage = number(stats.crit_dmg ?? stats.crit_damage);
  return [...leveled, ["冲击力", number(stats.break_stun), decimalStat],
    ["暴击率", critical === undefined ? undefined : critical / 10_000, percentStat],
    ["暴击伤害", criticalDamage === undefined ? undefined : criticalDamage / 10_000, percentStat]];
}

const genshinGrowthLabels: Readonly<Record<string, string>> = {
  fight_prop_hp_percent: "大生命", fight_prop_attack_percent: "大攻击", fight_prop_defense_percent: "大防御",
  fight_prop_critical: "暴击", fight_prop_critical_hurt: "爆伤", fight_prop_charge_efficiency: "充能",
  fight_prop_element_mastery: "精通", fight_prop_heal_add: "治疗",
  fight_prop_fire_add_hurt: "火伤", fight_prop_water_add_hurt: "水伤", fight_prop_wind_add_hurt: "风伤",
  fight_prop_ice_add_hurt: "冰伤", fight_prop_rock_add_hurt: "岩伤", fight_prop_elec_add_hurt: "雷伤",
  fight_prop_grass_add_hurt: "草伤", fight_prop_physical_add_hurt: "物伤",
};

function sectionBaseStats(game: Game, detail: RecordValue): RoleDetails["overview"]["sectionStats"] {
  if (game === "zzz") return;
  if (game === "hsr") {
    const stats = new Map(starRailStats(detail).map(([label, value]) => [label, value]));
    const rows = levelStats.map((label) => ({ label: `基础${label}`, value: stats.get(`Lv80${label}`) }));
    const speed = stats.get("速度");
    if (speed !== undefined) rows.push({ label: "速度", value: speed });
    if (!rows.slice(0, 3).every(({ value }) => value !== undefined)) return;
    return { level: 80, rows: rows.map(({ label, value }) => ({ label, value: decimalStat.format(value!) })) };
  }

  const modifiers = object(detail.stats_modifier);
  const ascension = values(modifiers.ascension).at(-1);
  if (!ascension) return;
  for (const level of [100, 90]) {
    const base = levelStats.map((stat) => ({ label: `基础${stat}`, value: genshinBase(detail, modifiers, stat, level, ascension) }));
    if (base.some(({ value }) => value === undefined)) continue;
    const rows = base.map(({ label, value }) => ({ label, value: decimalStat.format(Number(value!.toFixed(2))) }));
    const bonus = Object.entries(ascension).flatMap(([property, raw]) => {
      const label = genshinGrowthLabels[property];
      const value = number(raw);
      if (!label || !value) return [];
      return [{ label, value: (property === "fight_prop_element_mastery" ? decimalStat : percentStat).format(value) }];
    });
    if (bonus.length === 1) rows.push(bonus[0]!);
    return { level, rows };
  }
}

function overviewStats(game: Game, detail: RecordValue) {
  const rows = game === "gi" ? genshinStats(detail) : game === "hsr" ? starRailStats(detail) : zenlessStats(detail);
  const stats = rows.flatMap(([label, value, format = wholeStat]) =>
    value !== undefined && Number.isFinite(value) ? [{ label, value: format.format(value) }] : []);
  return stats.length ? stats : undefined;
}

// The existing Star Rail gallery uses the roster's gender and path names for the Trailblazer.
const trailblazerNames = new Map([
  ["8001", "穹·毁灭"], ["8002", "星·毁灭"], ["8003", "穹·存护"], ["8004", "星·存护"],
  ["8005", "穹·同谐"], ["8006", "星·同谐"], ["8007", "穹·记忆"], ["8008", "星·记忆"],
  ["8009", "穹·欢愉"], ["8010", "星·欢愉"],
]);

export function starRailTrailblazerName({ game, name, id }: Character): string | undefined {
  if (game === "hsr" && name === "{NICKNAME}") return trailblazerNames.get(id);
}

const travelerForms = new Map([
  ["10000005", { name: "空", icon: "UI_AvatarIcon_PlayerBoy" }],
  ["10000007", { name: "荧", icon: "UI_AvatarIcon_PlayerGirl" }],
  ["10000134", { name: "空", icon: "UI_AvatarIcon_PlayerBoy" }],
  ["10000135", { name: "荧", icon: "UI_AvatarIcon_PlayerGirl" }],
]);
const travelerElements = new Map([
  ["2", ["pyro", "火"]], ["3", ["hydro", "水"]], ["4", ["anemo", "风"]], ["5", ["cryo", "冰"]],
  ["6", ["geo", "岩"]], ["7", ["electro", "雷"]], ["8", ["dendro", "草"]],
]);

interface GenshinTraveler {
  readonly name: string;
  readonly portraitBase?: "10000005" | "10000007";
}

function genshinTraveler(character: Character, list: RecordValue, detail: RecordValue,
  element: GenshinElement | undefined): GenshinTraveler | undefined {
  if (character.game !== "gi" || character.name !== "旅行者" || detail.name !== character.name) return;
  const [base, suffix, extra] = character.id.split("-");
  const form = travelerForms.get(base ?? "");
  if (!form || extra !== undefined || list.icon !== form.icon || detail.icon !== form.icon) return;
  if (base === "10000134" || base === "10000135") {
    if (suffix === undefined && list.element === "None" && detail.element === "None" && detail.desc === "第三人称射击旅行者") {
      return { name: `旅行者·${form.name}（射击）` };
    }
    return;
  }
  const [expected, label] = travelerElements.get(suffix ?? "") ?? [];
  if ((base === "10000005" || base === "10000007") && expected && expected === element) {
    return { name: `旅行者·${form.name}（${label}）`, portraitBase: base };
  }
}

export function characterGalleryName(character: Character, roster: readonly Character[],
  verifiedTitle?: string): string | readonly string[] | undefined {
  const { game, id, name } = character;
  if (game === "hsr") {
    if (name === "{NICKNAME}") return starRailTrailblazerName(character);
    if (name === "三月七" && id === "1001") return name;
    if (name === "三月七" && id === "1224") return "三月七·巡猎";
  }
  const folded = name.normalize("NFKC").toLowerCase();
  if (roster.filter(entry => entry.game === game && entry.name.normalize("NFKC").toLowerCase() === folded).length !== 1) return;
  const verified = game === "zzz" ? zzzFullNames.get(id) : undefined;
  if (verified?.name === name && verified.fullName === verifiedTitle) {
    const fullName = verified.fullName.normalize("NFKC").toLowerCase();
    if (fullName !== folded && !roster.some(entry => entry.game === game && entry.id !== id &&
      entry.name.normalize("NFKC").toLowerCase() === fullName)) return [name, verified.fullName];
  }
  return name;
}

export function roleMaterialGroups(game: Game, detail: RecordValue, images?: unknown, materialNames?: unknown): RoleMaterialGroup[] {
  const artwork = galleryArtwork(images, game);
  const groups = game === "gi" ? genshinMaterials(detail, artwork)
    : game === "hsr" ? starRailMaterials(detail) : zenlessMaterials(detail);
  const names = object(materialNames);
  return groups.map(group => ({
    ...group,
    items: group.items.map(item => {
      if (!item.id) return item;
      return { ...item, name: item.name ?? text(names[item.id]),
        artwork: item.artwork ?? artwork(`derived.material.${item.id}`) };
    }),
  }));
}

export function normalizeRoleDetails(character: Character, content: RecordValue, rarity: string, images?: unknown,
  materialNames?: unknown): RoleDetails | undefined {
  const { game, id, version, name } = character;
  const detail = object(content.detail);
  if (!Object.keys(detail).length) return;
  const list = object(content.list);
  const element = game === "gi" ? genshinElement(list, detail) : undefined;
  const partner = object(detail.partner_info);
  const fullName = label(partner.full_name);
  const verifiedName = game === "zzz" ? zzzFullNames.get(id) : undefined;
  const trailblazer = starRailTrailblazerName(character);
  const traveler = genshinTraveler(character, list, detail, element);
  const title = verifiedName?.name === name && verifiedName.fullName === fullName ? fullName
    : trailblazer ?? traveler?.name ?? name;
  let description = text(detail.desc) ?? text(partner.profile_desc) ?? text(list.desc);
  if (game === "hsr") description = description?.replaceAll("{NICKNAME}", "开拓者");
  if (trailblazer && description) {
    const gender = trailblazer.startsWith("星") ? "F" : "M";
    description = description.replace(/\{([FM])#([^{}]*)\}/gu, (_, speaker, alternative) => speaker === gender ? alternative : "");
  }
  const artwork = galleryArtwork(images, game);
  const icon = artwork("detail.icon", "icon");
  const indexIcon = artwork("icon");
  const iconFallback = indexIcon !== icon ? indexIcon : undefined;
  const [portrait, ...portraitFallbacks] = [...new Set(focusFields[game].flatMap((field) => {
    const path = artwork(field);
    return path ? [path] : [];
  }))];
  const railSkills = game === "hsr" ? starRailSkills(id, detail, artwork) : undefined;
  const skills = railSkills?.skills ?? (game === "gi" ? genshinSkills(detail, artwork) : zenlessSkillsAndCores(detail, artwork));
  const materials = roleMaterialGroups(game, detail, images, materialNames);
  return {
    game, id, version, skills, sectionSkills: railSkills?.sectionSkills, ranks: ranksFor(game, detail, artwork), materials,
    overview: { name: title, rarity, description,
      artwork: portrait ?? icon, icon, portraitFallbacks: portraitFallbacks.length ? portraitFallbacks : undefined,
      iconFallback, element, traveler, facts: overviewFacts(game, detail), stats: overviewStats(game, detail),
      sectionStats: sectionBaseStats(game, detail) },
  };
}
