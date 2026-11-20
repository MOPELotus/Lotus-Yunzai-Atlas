import type { AtlasEntry, Game } from "./catalog.ts";
import { effectText, galleryArtwork, label, object } from "./source-values.ts";

export interface WeaponDetails {
  readonly game: Game;
  readonly name: string;
  readonly version: string;
  readonly artwork?: string;
  readonly description?: string;
  readonly stats: readonly { label: string; value: string }[];
  readonly refinements: readonly { rank: number; name: string; description: string }[];
  readonly story?: string;
}

const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const stats = new Map<string, readonly [string, Intl.NumberFormat]>([
  ["atk", ["基础攻击力", whole]],
  ["fight_prop_element_mastery", ["元素精通", whole]],
]);
for (const [key, name] of [
  ["attack_percent", "攻击力"], ["defense_percent", "防御力"], ["hp_percent", "生命值"],
  ["critical", "暴击率"], ["critical_hurt", "暴击伤害"], ["charge_efficiency", "元素充能效率"],
  ["physical_add_hurt", "物理伤害加成"],
] as const) stats.set(`fight_prop_${key}`, [name, percent]);

function sourceNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function numbered(value: unknown) {
  const entries = Array.isArray(value) ? Object.entries(value) : Object.entries(object(value));
  return entries.flatMap(([key, row]) => /^(?:0|[1-9]\d*)$/u.test(key) && Number.isSafeInteger(Number(key))
    ? [{ key: Number(key), row: object(row) }] : []);
}

function refinement(rank: number, name: unknown, source: unknown, params: unknown,
  truncateInteger = false): WeaponDetails["refinements"] {
  if (!Number.isInteger(rank) || rank < 1 || rank > 5) return [];
  const title = label(name);
  const description = effectText(source, Array.isArray(params) ? params : undefined, true, truncateInteger);
  return title || description ? [{ rank, name: title, description }] : [];
}

function genshin(detail: Record<string, unknown>, list: Record<string, unknown>, indexedRarity: string) {
  const rarity = detail.rarity ?? list.rank;
  const lowRarity = rarity === 1 || rarity === 2 || (rarity === undefined && (indexedRarity === "一星" || indexedRarity === "二星"));
  const [cap, finalStage] = lowRarity ? [70, 4] : [90, 6];
  const stages = detail.ascension;
  const finalAscension = object(Array.isArray(stages) && (stages.length === finalStage || stages.length === finalStage + 1)
    ? stages.at(-1)
    : object(stages)[finalStage]);
  const attackBonus = sourceNumber(finalAscension.fight_prop_base_attack);
  const facts = Object.entries(object(detail.stats_modifier)).flatMap(([field, value]) => {
    const kind = stats.get(field);
    const row = object(value);
    const base = sourceNumber(row.base);
    if (!kind || base === undefined) return [];
    const [name, format] = kind;
    const levels = object(row.levels);
    return [1, cap].flatMap((level) => {
      const modifier = sourceNumber(levels[level]);
      const bonus = field === "atk" && level === cap ? attackBonus : 0;
      if (modifier === undefined || bonus === undefined) return [];
      const result = base * modifier + bonus;
      return Number.isFinite(result) ? [{ label: `Lv${level}${name}`, value: format.format(result) }] : [];
    });
  });

  return { stats: facts, refinements: numbered(detail.refinement).flatMap(({ key, row }) =>
    refinement(key, row.name, row.desc, row.param_list)) };
}

function starRail(detail: Record<string, unknown>) {
  const stages = numbered(detail.stats);
  const first = stages.find(({ key }) => key === 0)?.row;
  const last = stages.at(-1)?.row;
  const cap = sourceNumber(last?.max_level);
  const required = [["hp", "生命"], ["attack", "攻击"], ["defence", "防御"]] as const;
  const stats = required.flatMap(([key, name]) => {
    const firstValue = sourceNumber(first?.[`base_${key}`]);
    const base = sourceNumber(last?.[`base_${key}`]);
    const rate = sourceNumber(last?.[`base_${key}_add`]);
    const facts = firstValue === undefined ? [] : [{ label: `Lv1${name}`, value: whole.format(firstValue) }];
    if (cap !== undefined && Number.isInteger(cap) && cap > 1 && base !== undefined && rate !== undefined) {
      const value = base + rate * (cap - 1);
      if (Number.isFinite(value)) facts.push({ label: `Lv${cap}${name}`, value: whole.format(value) });
    }
    return facts;
  });
  const effect = object(detail.refinements);
  const refinements = numbered(effect.level).flatMap(({ key, row }) =>
    refinement(row.level === undefined ? key : sourceNumber(row.level) ?? 0, effect.name, effect.desc, row.param_list, true));
  return { stats, refinements };
}

function zenless(detail: Record<string, unknown>) {
  const levels = numbered(detail.level);
  const stars = numbered(detail.stars);
  const firstLevel = levels.find(({ key }) => key === 0)?.row;
  const firstStar = stars.find(({ key }) => key === 0)?.row;
  const lastLevel = levels.at(-1);
  const lastStar = stars.at(-1)?.row;
  const stats = ["base_property", "rand_property"].flatMap((field) => {
    const property = object(detail[field]);
    const name = label(property.name);
    const base = sourceNumber(property.value);
    if (!name || base === undefined) return [];
    const attack = field === "base_property";
    const format = attack ? whole : label(property.format).includes("%") ? percent : decimal;
    const cap = lastLevel && lastLevel.key > 1 ? lastLevel.key : undefined;
    return ([[1, firstLevel, firstStar], [cap, lastLevel?.row, lastStar]] as const).flatMap(([level, growth, promotion]) => {
      if (typeof level !== "number" || level < 1 || !growth || !promotion) return [];
      const promotionRate = sourceNumber(promotion[attack ? "star_rate" : "rand_rate"]);
      const growthRate = attack ? sourceNumber(growth.rate) : 0;
      if (promotionRate === undefined || growthRate === undefined) return [];
      const value = base * (1 + growthRate / 10_000) + base * promotionRate / 10_000;
      const display = format === percent ? value / 10_000 : value;
      return Number.isFinite(display) ? [{ label: `Lv${level}${name}`, value: format.format(display) }] : [];
    });
  });
  return { stats, refinements: numbered(detail.talents).flatMap(({ key, row }) =>
    refinement(key, row.name, row.desc, row.param ?? row.param_list)) };
}

export function normalizeWeapon(entry: AtlasEntry, content: Record<string, unknown>, images: unknown): WeaponDetails | undefined {
  const { game } = entry;
  const detail = object(content.detail);
  if (!Object.keys(detail).length) return;
  const { stats, refinements } = game === "gi" ? genshin(detail, object(content.list), entry.rarity)
    : game === "hsr" ? starRail(detail) : zenless(detail);
  const description = effectText(detail.desc);
  const story = effectText(detail.story) || effectText(detail.background);
  if (!description && !stats.length && !refinements.length && !story) return;
  const artwork = galleryArtwork(images, game);
  const icon = game === "hsr" ? artwork("derived.lightConeMediumIcon", "detail.derived.lightConeMediumIcon", "detail.icon", "icon")
    : artwork("detail.icon", "icon");
  return { game, name: entry.name, version: entry.version, artwork: icon,
    description: description || undefined, stats, refinements, story: story || undefined };
}
