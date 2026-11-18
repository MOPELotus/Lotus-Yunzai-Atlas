import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { challengeModes, readChallengeFacts, type ChallengeMode } from "./challenges.ts";
import { compareKey, effectText, label, object } from "./source-values.ts";
import { readAchievementCategories, type AchievementCategory } from "./achievements.ts";

export const gameNames = { gi: "原神", hsr: "星铁", zzz: "绝区零" } as const;
export type Game = keyof typeof gameNames;

const equipmentPages = {
  gi: { id: "weapon", name: "武器" },
  hsr: { id: "lightcone", name: "光锥" },
  zzz: { id: "weapon", name: "音擎" },
} as const;

const setPages = {
  gi: { id: "artifact", name: "圣遗物" },
  hsr: { id: "relicset", name: "遗器套装" },
  zzz: { id: "equipment", name: "驱动盘" },
} as const;

const achievementPage = { id: "achievement/achievement", name: "成就" } as const;
const bangbooPage = { id: "bangboo", name: "邦布" } as const;
const kinds = ["character", "equipment", "set", "bangboo", "achievement"] as const;
type StandardKind = typeof kinds[number];
type Kind = StandardKind | "challenge";

function pageFor(game: Game, kind: StandardKind): { id: string; name: string } | undefined {
  switch (kind) {
    case "character": return { id: "character", name: "角色" };
    case "equipment": return equipmentPages[game];
    case "set": return setPages[game];
    case "achievement": return achievementPage;
    case "bangboo": return game === "zzz" ? bangbooPage : undefined;
  }
}

export interface AtlasEntry {
  readonly game: Game;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly rarity: string;
  readonly path: string;
}

export type Character = AtlasEntry;

interface AtlasPage {
  readonly game: Game;
  readonly version: string;
  readonly sampled: boolean;
  readonly kind: Kind;
  readonly name: string;
  readonly entries: readonly AtlasEntry[];
  readonly challengeMode?: ChallengeMode;
  readonly sourceUrl?: string;
  readonly achievementCategories?: readonly AchievementCategory[];
}

interface Catalog {
  readonly pages: readonly AtlasPage[];
  readonly stale: boolean;
}

interface Snapshot extends Catalog {
  readonly map: Buffer;
}

function readPage(game: Game, kind: Kind, name: string, value: unknown): AtlasPage {
  const page = object(value);
  const version = label(page.version);
  const records = Object.values(object(page.records));
  if (!version || !records.length || page.recordCount !== records.length) {
    throw new Error(`${name}索引缺项或收录数量不符。`);
  }
  const ids = new Set<string>();
  const entries: AtlasEntry[] = [];
  for (const row of records) {
    const record = object(row);
    const id = label(record.id);
    const title = label(record.name);
    const path = label(record.path);
    if (!id || !title || !path.startsWith("items/") || !path.endsWith(".json") ||
        path.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\\")) ||
        ids.has(id)) {
      throw new Error(`${name}索引包含无效或重复的条目。`);
    }
    ids.add(id);
    entries.push({ game, id, name: title, version, path, rarity: label(record.rarity) });
  }
  return { game, kind, name, version, sampled: page.sampled === true, entries };
}

function score(entry: AtlasEntry, key: string): number {
  const name = compareKey(entry.name);
  if (entry.id === key || name === key) return 3;
  if (name.startsWith(key)) return 2;
  return name.includes(key) ? 1 : 0;
}

function findEntries(catalog: Catalog, kind: Kind, query: string, game?: Game): AtlasEntry[] {
  const key = compareKey(query);
  if (!key) return [];
  const matches = catalog.pages
    .filter((page) => page.kind === kind && (!game || page.game === game))
    .flatMap((page) => page.entries.map((entry) => ({ entry, score: score(entry, key) })))
    .filter((match) => match.score > 0);
  const best = Math.max(...matches.map((match) => match.score));
  return matches.filter((match) => match.score === best).map(({ entry }) => entry);
}

export function findCharacters(catalog: Catalog, query: string, game?: Game): Character[] {
  return findEntries(catalog, "character", query, game);
}

export function findEquipment(catalog: Catalog, query: string, game?: Game): AtlasEntry[] {
  return findEntries(catalog, "equipment", query, game);
}

export function findSets(catalog: Catalog, query: string, game?: Game): AtlasEntry[] {
  return findEntries(catalog, "set", query, game);
}

export function findBangboos(catalog: Catalog, query: string): AtlasEntry[] {
  return findEntries(catalog, "bangboo", query, "zzz");
}

const weaponTypes = new Map([
  ["WEAPON_SWORD_ONE_HAND", "单手剑"], ["WEAPON_CLAYMORE", "双手剑"],
  ["WEAPON_CATALYST", "法器"], ["WEAPON_BOW", "弓"], ["WEAPON_POLE", "长柄武器"],
]);

const lightConePaths = new Map([
  ["Warrior", "毁灭"], ["Rogue", "巡猎"], ["Mage", "智识"],
  ["Warlock", "虚无"], ["Shaman", "同谐"], ["Knight", "存护"],
  ["Priest", "丰饶"], ["Memory", "记忆"], ["Elation", "欢愉"],
]);

const wEngineSpecialties = new Map([
  [1, "强攻"], [2, "击破"], [3, "异常"], [4, "支援"],
  [5, "防护"], [6, "命破"], [7, "锋御"],
]);

function zzzRarity(rank: unknown): string {
  switch (rank) {
    case 2: return "B级";
    case 3: return "A级";
    case 4: return "S级";
    default: return "";
  }
}

function artifactName(list: Record<string, unknown>): string {
  const names = new Set(Object.values(object(list.set)).map((affix) =>
    label(object(object(affix).name).zh)).filter(Boolean));
  return names.size === 1 ? [...names][0] ?? "" : "";
}

interface SetEffect {
  readonly pieces: number;
  readonly text: string;
}

function setEffects(game: Game, detail: Record<string, unknown>): SetEffect[] {
  if (game === "gi" && Array.isArray(detail.need) && Array.isArray(detail.affix) &&
      detail.need.length === detail.affix.length) {
    const affixes = detail.affix;
    return detail.need.flatMap((pieces, index) => pieces === 1 || pieces === 2 || pieces === 4
      ? [{ pieces, text: effectText(object(affixes[index]).desc) }] : []);
  }
  if (game === "hsr") {
    return Object.entries(object(detail.require_num)).flatMap(([count, value]) => {
      if (count !== "2" && count !== "4") return [];
      const effect = object(value);
      return [{ pieces: Number(count), text: effectText(effect.desc,
        Array.isArray(effect.param_list) ? effect.param_list : undefined) }];
    });
  }
  if (game === "zzz") {
    return ([2, 4] as const).flatMap((pieces) => detail[`desc${pieces}`]
      ? [{ pieces, text: effectText(detail[`desc${pieces}`]) }] : []);
  }
  return [];
}

export function createAtlasCatalog(directory: string) {
  const mapPath = resolve(directory, "map.json");
  let snapshot: Snapshot | undefined;
  let reading: Promise<Catalog> | undefined;

  async function read(): Promise<Catalog> {
    try {
      const map = await readFile(mapPath);
      if (!snapshot || snapshot.stale || !map.equals(snapshot.map)) {
        const source = object(JSON.parse(map.toString("utf8")));
        const pages: AtlasPage[] = [];
        let stale = false;
        for (const game of Object.keys(gameNames) as Game[]) {
          const gameBlock = object(object(source.games)[game]);
          const locale = object(object(gameBlock.locales).zh);
          const rawPages = object(locale.pages);
          const standardPages = kinds.flatMap((kind) => {
            const page = pageFor(game, kind);
            return page ? [{ ...page, kind, challengeMode: undefined }] : [];
          });
          const challengePages = challengeModes.filter((mode) => mode.game === game)
            .map((mode) => ({ id: mode.id, name: mode.name, kind: "challenge" as const, challengeMode: mode }));
          for (const { id: pageId, name, kind, challengeMode } of [...standardPages, ...challengePages]) {
            const previous = snapshot?.pages.find((page) =>
              page.game === game && page.kind === kind && page.challengeMode?.id === challengeMode?.id);
            const value = rawPages[pageId];
            if (value === undefined && !previous) continue;

            try {
              const page = readPage(game, kind, name, value);
              if (kind === "set" && game === "gi") {
                const entries: AtlasEntry[] = [];
                for (const entry of page.entries) {
                  const name = artifactName(object((await readContent(entry, pageId)).list));
                  if (!name) throw new Error("圣遗物套装名称缺失或不一致。");
                  entries.push({ ...entry, name });
                }
                pages.push({ ...page, entries });
              } else if (kind === "achievement") {
                const sources = [];
                for (const entry of page.entries) {
                  sources.push({ id: entry.id, name: entry.name,
                    list: (await readContent(entry, pageId)).list });
                }
                const achievementCategories = readAchievementCategories(game, {
                  version: page.version,
                  sourceUrl: label(object(value).sourceUrl),
                  sources,
                });
                pages.push({ ...page, achievementCategories });
              } else if (challengeMode) {
                pages.push({ ...page, challengeMode, sourceUrl: label(object(value).sourceUrl) });
              } else {
                pages.push(page);
              }
            } catch {
              stale = true;
              if (previous) pages.push(previous);
            }
          }
        }
        if (!pages.length) throw new Error("图鉴索引没有可查询的分类。");
        snapshot = { map, pages, stale };
      }
      return { pages: snapshot.pages, stale: snapshot.stale };
    } catch (error) {
      if (snapshot) return { pages: snapshot.pages, stale: true };
      throw error;
    }
  }

  async function readContent(entry: AtlasEntry, pageId: string): Promise<Record<string, unknown>> {
    try {
      const root = await realpath(directory);
      const file = await realpath(resolve(root, entry.path));
      const local = relative(root, file);
      if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) return {};
      const item = object(JSON.parse(await readFile(file, "utf8")));
      const meta = object(item.meta);
      if (meta.gameId !== entry.game || meta.pageId !== pageId || meta.recordId !== entry.id ||
          meta.version !== entry.version) return {};
      return object(item.content);
    } catch {
      return {};
    }
  }

  return {
    read(): Promise<Catalog> {
      return reading ??= read().finally(() => { reading = undefined; });
    },
    async characterRarity(character: Character): Promise<string> {
      if (character.game !== "zzz") return character.rarity;
      const { rank } = object((await readContent(character, "character")).list);
      return rank === 2 ? "" : zzzRarity(rank);
    },
    async equipmentFacts(entry: AtlasEntry) {
      const page = equipmentPages[entry.game];
      const detail = object((await readContent(entry, page.id)).list);
      let scope = "";
      if (entry.game === "gi") scope = weaponTypes.get(label(detail.type)) ?? "";
      if (entry.game === "hsr") scope = lightConePaths.get(label(detail.baseType)) ?? "";
      if (entry.game === "zzz" && typeof detail.type === "number") {
        scope = wEngineSpecialties.get(detail.type) ?? "";
      }
      return {
        category: page.name,
        rarity: entry.game === "zzz" ? zzzRarity(detail.rank) : entry.rarity,
        scope,
      };
    },
    async setFacts(entry: AtlasEntry) {
      const category = setPages[entry.game];
      const detail = object((await readContent(entry, category.id)).detail);
      const effects = setEffects(entry.game, detail);
      const planar = entry.game === "hsr" && Object.keys(object(detail.parts)).length === 2 &&
        effects.length === 1 && effects[0]?.pieces === 2;
      return { category: planar ? "位面饰品" : category.name, effects };
    },
    async challengeFacts(entry: AtlasEntry, mode: ChallengeMode) {
      const content = await readContent(entry, mode.id);
      return readChallengeFacts(mode, content);
    },
    async bangbooRarity(entry: AtlasEntry): Promise<string> {
      if (entry.game !== "zzz") return "";
      const content = await readContent(entry, bangbooPage.id);
      const { rank } = object(content.list);
      const { rarity } = object(content.detail);
      if ((rank !== 3 && rank !== 4) || (rarity !== undefined && rarity !== rank)) return "";
      return zzzRarity(rank);
    },
  };
}
