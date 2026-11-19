import type { AtlasEntry } from "./catalog.ts";
import { effectText, galleryArtwork, label, object } from "./source-values.ts";

export interface WeaponDetails {
  readonly name: string;
  readonly version: string;
  readonly artwork?: string;
  readonly description?: string;
  readonly stats: readonly { label: string; value: string }[];
  readonly refinements: readonly { rank: number; name: string; description: string }[];
  readonly story?: string;
}

const stats = new Map<string, readonly [string, Intl.NumberFormat]>([
  ["atk", ["基础攻击力", new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })]],
  ["fight_prop_element_mastery", ["元素精通", new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })]],
]);
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
for (const [key, name] of [
  ["attack_percent", "攻击力"], ["defense_percent", "防御力"], ["hp_percent", "生命值"],
  ["critical", "暴击率"], ["critical_hurt", "暴击伤害"], ["charge_efficiency", "元素充能效率"],
  ["physical_add_hurt", "物理伤害加成"],
] as const) stats.set(`fight_prop_${key}`, [name, percent]);

function sourceNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function normalizeGenshinWeapon(entry: AtlasEntry, content: Record<string, unknown>, images: unknown): WeaponDetails | undefined {
  if (entry.game !== "gi") return;
  const detail = object(content.detail);
  if (!Object.keys(detail).length) return;

  const stages = Array.isArray(detail.ascension) ? detail.ascension : Object.values(object(detail.ascension));
  const finalAscension = object(stages.at(-1));
  const attackBonus = sourceNumber(finalAscension.fight_prop_base_attack);
  const facts = Object.entries(object(detail.stats_modifier)).flatMap(([field, value]) => {
    const kind = stats.get(field);
    const row = object(value);
    const base = sourceNumber(row.base);
    if (!kind || base === undefined) return [];
    const [name, format] = kind;
    const levels = object(row.levels);
    return [1, 90].flatMap((level) => {
      const modifier = sourceNumber(levels[level]);
      const bonus = field === "atk" && level === 90 ? attackBonus : 0;
      if (modifier === undefined || bonus === undefined) return [];
      const result = base * modifier + bonus;
      return Number.isFinite(result) ? [{ label: `Lv${level}${name}`, value: format.format(result) }] : [];
    });
  });

  const refinements = Object.entries(object(detail.refinement)).flatMap(([key, value]) => {
    if (!/^[1-5]$/u.test(key)) return [];
    const { name, desc, param_list } = object(value);
    const description = effectText(desc, Array.isArray(param_list) ? param_list : undefined, true);
    return label(name) || description ? [{ rank: Number(key), name: label(name), description }] : [];
  });
  const description = effectText(detail.desc);
  const story = effectText(detail.story);
  if (!description && !facts.length && !refinements.length && !story) return;
  return { name: entry.name, version: entry.version, artwork: galleryArtwork(images, "gi")("detail.icon", "icon"),
    description: description || undefined, stats: facts, refinements, story: story || undefined };
}
