import type { AtlasEntry } from "./catalog.ts";
import { effectText, galleryArtwork, label, object } from "./source-values.ts";

interface BangbooSkill {
  readonly name: string;
  readonly type: string;
  readonly description: string;
  readonly artwork?: string;
  readonly levels: readonly number[];
  readonly rows: readonly { label: string; values: readonly string[] }[];
}

export interface BangbooDetails {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly artwork?: string;
  readonly stats: readonly { label: string; value: string }[];
  readonly skills: readonly BangbooSkill[];
}

const skillTypes: ReadonlyMap<string, readonly [string, string]> = new Map([
  ["a", ["主动技", "IconRoleSkillKeySpecial"]],
  ["b", ["额外能力", "Icon_CoreSkill"]],
  ["c", ["邦布连携技", "Icon_UltimateReady"]],
]);
const integer = new Intl.NumberFormat("zh-Hans-CN", { maximumFractionDigits: 0 });

function sourceNumber(value: unknown) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/u.test(value))) return;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function fixed(value: number, digits = 1) {
  return String(Number(value.toFixed(digits)));
}

function skillValue(value: string, level: number, properties: Record<string, unknown>): string {
  // Split-hit expressions in the legacy table display the underlying property once.
  const binding = /\{Skill:(\d+),\s*Prop:(\d+)\}/u.exec(value);
  if (!binding) return effectText(value);
  const property = object(object(properties[binding[1]!])[binding[2]!]);
  const base = sourceNumber(property.main);
  const growth = sourceNumber(property.growth);
  if (base === undefined && growth === undefined) return "";
  const result = (base ?? 0) + (growth ?? 0) * (level - 1);
  if (!Number.isFinite(result)) return "";
  return label(property.format).includes("%") ? `${fixed(result / 100)}%` : fixed(result);
}

function bangbooSkills(detail: Record<string, unknown>): BangbooSkill[] {
  const properties = object(detail.skill_prop);
  return Object.entries(object(detail.skill)).flatMap(([key, source]) => {
    const levelSource = object(source).level;
    if (typeof levelSource !== "object" || levelSource === null) return [];
    const rawEntries = Array.isArray(levelSource) ? levelSource : Object.values(object(levelSource));
    const entries = rawEntries.map(object).filter((value) => Object.keys(value).length > 0);
    if (rawEntries.length && !entries.length) return [];
    // Named slots can exist without level data, such as the three slots of 伊埃斯.
    const first = entries[0] ?? {};
    const definition = skillTypes.get(key);
    const type = definition?.[0] ?? effectText(key);
    const name = effectText(first.name) || type;
    const description = effectText(first.desc);
    const levels = entries.map((entry, index) => {
      const level = sourceNumber(entry.level);
      return level !== undefined && Number.isSafeInteger(level) && level > 0 ? level : index + 1;
    });
    const parameters = entries.map((entry) => label(entry.param).split("|"));
    const rows = (Array.isArray(first.property) ? first.property : []).flatMap((property, index) => {
      const name = effectText(property);
      const values = parameters.map((fields, column) => skillValue(fields[index] ?? "", levels[column]!, properties));
      return name && values.some(Boolean) ? [{ label: name, values }] : [];
    });
    if (!name && !description && !rows.length) return [];
    return [{ name, type, description, levels, rows, ...(definition ? { artwork: `gallery/zzz/${definition[1]}.webp` } : {}) }];
  });
}

function bangbooStats(detail: Record<string, unknown>): BangbooDetails["stats"] {
  const stats = object(detail.stats);
  return ([
    ["生命值", stats.hp_max, "integer"],
    ["攻击力", stats.attack, "integer"],
    ["防御力", stats.defence, "integer"],
    ["冲击力", stats.break_stun, "number"],
    ["异常掌控", stats.element_abnormal_power, "number"],
    ["暴击率", stats.crit, "percent"],
    ["暴击伤害", stats.crit_dmg ?? stats.crit_damage, "percent"],
    ["耐久", stats.endurance, "number"],
  ] as const).flatMap<BangbooDetails["stats"][number]>(([label, raw, kind]) => {
    const number = sourceNumber(raw);
    if (number === undefined) return [];
    if (kind === "integer") return [{ label, value: integer.format(Math.round(number)) }];
    if (kind === "percent") return [{ label, value: `${fixed(number / 100)}%` }];
    return [{ label, value: fixed(number, Math.abs(number) < 10 ? 1 : 0) }];
  });
}

export function normalizeBangbooDetails(
  entry: Pick<AtlasEntry, "id" | "name" | "version">, content: unknown, images?: unknown,
): BangbooDetails | undefined {
  const { detail: detailSource, list } = object(content);
  const detail = object(detailSource);
  if ((typeof detail.id !== "string" && typeof detail.id !== "number") || String(detail.id) !== entry.id) return;
  const description = effectText(detail.desc) || effectText(object(list).desc);
  const artwork = galleryArtwork(images, "zzz")("detail.icon", "icon", "list.icon");
  return {
    name: entry.name, version: entry.version, description, artwork, stats: bangbooStats(detail), skills: bangbooSkills(detail),
  };
}
