import type { Game } from "./catalog.ts";
import { compareKey, effectText, label, object } from "./source-values.ts";

export interface Achievement {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly priority?: number;
  readonly points?: number;
  readonly target?: number;
}

export interface AchievementCategory {
  readonly game: Game;
  readonly id: string;
  readonly name: string;
  readonly parent?: string;
  readonly priority?: number;
  readonly version: string;
  readonly sourceUrl: string;
  readonly entries: readonly Achievement[];
}

interface AchievementSource {
  readonly id: string;
  readonly name: string;
  readonly list: unknown;
}

interface SourcePage {
  readonly version: string;
  readonly sourceUrl: string;
  readonly sources: readonly AchievementSource[];
}

function idOf(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  const id = label(value);
  return /^\d+$/u.test(id) ? id : "";
}

function integer(value: unknown): number | undefined {
  const number = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof number === "number" && Number.isSafeInteger(number) && number >= 0) return number;
}

function achievement(value: unknown, sourceId?: string, game?: Game): Achievement {
  const row = object(value);
  const id = sourceId === undefined ? idOf(row.id) : idOf(sourceId);
  const name = label(row.name);
  if (!id || !name) throw new Error("成就条目的 ID 或名称无效。");
  const reward = object(row.reward);
  return {
    id, name, description: effectText(row.desc, Array.isArray(row.param_list) ? row.param_list : undefined, true),
    ...(game === "gi" ? {
      priority: integer(row.priority), points: integer(reward.item_count ?? reward.count), target: integer(row.param),
    } : {}),
  };
}

function readGroups(game: "gi" | "hsr", page: SourcePage): AchievementCategory[] {
  return page.sources.map(({ id, name, list }) => {
    const category = object(list);
    if (idOf(category.id) !== id || label(category.name) !== name || !Array.isArray(category.list)) {
      throw new Error("成就分类与同版本详情不一致。");
    }
    return {
      game, id, name, version: page.version, sourceUrl: page.sourceUrl,
      ...(game === "gi" ? { priority: integer(category.priority) } : {}),
      entries: category.list.map((row) => achievement(row, undefined, game)),
    };
  });
}

function readZzzGroups(page: SourcePage): AchievementCategory[] {
  const categories = object(page.sources.find(({ id }) => id === "category")?.list);
  const achievements = object(page.sources.find(({ id }) => id === "achievement")?.list);
  if (!Object.keys(categories).length || !Object.keys(achievements).length) {
    throw new Error("绝区零成就缺少分类表或条目表。");
  }

  const groups = new Map<string, AchievementCategory & { entries: Achievement[] }>();
  for (const item of Object.values(categories)) {
    const category = object(item);
    const parent = label(category.name);
    if (!parent) throw new Error("绝区零成就一级分类缺少名称。");
    const subgroups = Object.entries(object(category.group))
      .sort(([, left], [, right]) => Number(object(left).sort) - Number(object(right).sort));
    for (const [id, value] of subgroups) {
      const name = label(object(value).name);
      if (!idOf(id) || !name || groups.has(id)) throw new Error("绝区零成就子分类无效。");
      groups.set(id, { game: "zzz", id, parent, name, version: page.version,
        sourceUrl: page.sourceUrl, entries: [] });
    }
  }
  for (const [id, value] of Object.entries(achievements)) {
    const group = groups.get(idOf(object(value).group));
    if (!group) throw new Error("绝区零成就无法关联到分类。");
    group.entries.push(achievement(value, id));
  }
  return [...groups.values()];
}

export function readAchievementCategories(game: Game, page: SourcePage): AchievementCategory[] {
  const categories = game === "zzz" ? readZzzGroups(page) : readGroups(game, page);
  const ids = new Set<string>();
  for (const category of categories) {
    for (const entry of category.entries) {
      if (ids.has(entry.id)) throw new Error("成就索引有重复条目 ID。");
      ids.add(entry.id);
    }
  }
  if (!ids.size) throw new Error("成就页没有可查询的条目。");
  return categories;
}

export function findAchievementCategories(
  categories: readonly AchievementCategory[], query = "", game?: Game,
): AchievementCategory[] {
  const filtered = categories.filter((category) => !game || category.game === game);
  if (!query.trim()) return filtered;

  const key = compareKey(query);
  if (!key) return [];
  const exact = filtered.filter((category) => category.id === key ||
    compareKey(category.name) === key || compareKey(`${category.parent ?? ""}${category.name}`) === key);
  if (exact.length) return exact;

  return filtered.filter((category) => compareKey(category.parent ?? "") === key ||
    compareKey(category.name).includes(key));
}

export function findAchievements(categories: readonly AchievementCategory[], query: string, game?: Game) {
  const key = compareKey(query);
  if (!key) return [];
  const found = [];
  let best = 0;
  for (const category of categories) {
    if (game && category.game !== game) continue;
    for (const entry of category.entries) {
      const name = compareKey(entry.name);
      const score = entry.id === key || name === key ? 2 : name.includes(key) ? 1 : 0;
      if (!score || score < best) continue;
      if (score > best) {
        best = score;
        found.length = 0;
      }
      found.push({ category, entry });
    }
  }
  return found;
}
