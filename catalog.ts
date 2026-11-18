import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const gameNames = { gi: "原神", hsr: "星铁", zzz: "绝区零" } as const;
export type Game = keyof typeof gameNames;

export interface Character {
  readonly game: Game;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly rarity: string;
  readonly path: string;
}

interface CharacterPage {
  readonly game: Game;
  readonly version: string;
  readonly sampled: boolean;
  readonly entries: readonly Character[];
}

interface Catalog {
  readonly pages: readonly CharacterPage[];
  readonly stale: boolean;
}

interface Snapshot {
  readonly stamp: string;
  readonly pages: readonly CharacterPage[];
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function label(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readPage(game: Game, value: unknown): CharacterPage {
  const page = object(value);
  const version = label(page.version);
  const records = Object.values(object(page.records));
  if (!version || !records.length || page.recordCount !== records.length) {
    throw new Error("角色索引缺项或收录数量不符。");
  }
  const ids = new Set<string>();
  const entries: Character[] = [];
  for (const row of records) {
    const record = object(row);
    const id = label(record.id);
    const name = label(record.name);
    const path = label(record.path);
    if (!id || !name || !path.startsWith("items/") || !path.endsWith(".json") ||
        path.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\\")) ||
        ids.has(id)) {
      throw new Error("角色索引包含无效或重复的条目。");
    }
    ids.add(id);
    entries.push({ game, id, name, version, path, rarity: label(record.rarity) });
  }
  return { game, version, sampled: page.sampled === true, entries };
}

function compareKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function score(character: Character, key: string): number {
  const name = compareKey(character.name);
  if (character.id === key || name === key) return 3;
  if (name.startsWith(key)) return 2;
  return name.includes(key) ? 1 : 0;
}

export function findCharacters(catalog: Catalog, query: string, game?: Game): Character[] {
  const key = compareKey(query);
  if (!key) return [];
  const matches = catalog.pages
    .filter((page) => !game || page.game === game)
    .flatMap((page) => page.entries.map((entry) => ({ entry, score: score(entry, key) })))
    .filter((match) => match.score > 0);
  const best = Math.max(...matches.map((match) => match.score));
  return matches.filter((match) => match.score === best).map(({ entry }) => entry);
}

export function createAtlasCatalog(directory: string) {
  const mapPath = resolve(directory, "map.json");
  let snapshot: Snapshot | undefined;
  let reading: Promise<Catalog> | undefined;

  async function read(): Promise<Catalog> {
    try {
      const info = await stat(mapPath);
      const stamp = [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
      if (stamp !== snapshot?.stamp) {
        const source = object(JSON.parse(await readFile(mapPath, "utf8")));
        const pages = (Object.keys(gameNames) as Game[]).flatMap((game) => {
          const gameBlock = object(object(source.games)[game]);
          const locale = object(object(gameBlock.locales).zh);
          const page = object(locale.pages).character;
          return page === undefined ? [] : [readPage(game, page)];
        });
        if (!pages.length || snapshot?.pages.some((previous) => !pages.some((next) => next.game === previous.game))) {
          throw new Error("角色索引缺少已收录的游戏。");
        }
        snapshot = { stamp, pages };
      }
      return { pages: snapshot.pages, stale: false };
    } catch (error) {
      if (snapshot) return { pages: snapshot.pages, stale: true };
      throw error;
    }
  }

  return {
    read(): Promise<Catalog> {
      return reading ??= read().finally(() => { reading = undefined; });
    },
    async characterRarity(character: Character): Promise<string> {
      if (character.game !== "zzz") return character.rarity;
      try {
        const root = await realpath(directory);
        const file = await realpath(resolve(root, character.path));
        const local = relative(root, file);
        if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) return "";
        const item = object(JSON.parse(await readFile(file, "utf8")));
        const meta = object(item.meta);
        if (meta.gameId !== "zzz" || meta.pageId !== "character" || meta.recordId !== character.id ||
            meta.version !== character.version) return "";
        const rank = object(object(item.content).list).rank;
        if (rank === 3) return "A级";
        if (rank === 4) return "S级";
      } catch {
        return "";
      }
      return "";
    },
  };
}
