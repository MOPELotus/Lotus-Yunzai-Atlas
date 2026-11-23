import { atlasLocaleBlock, defaultAtlasLocale, parseAtlasLocale, type AtlasLocale } from "./locale.ts";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { challengeModes, readChallengeFacts, type ChallengeMode } from "./challenges.ts";
import { compareKey, effectText, galleryArtwork, label, object } from "./source-values.ts";
import { readAchievementCategories, type AchievementCategory } from "./achievements.ts";
import { normalizeRoleDetails, starRailTrailblazerName, type RoleDetails } from "./role-data.ts";
import { normalizeWeapon } from "./weapon-data.ts";
import { normalizeSet, setEffects } from "./set-data.ts";
import { normalizeOnslaught } from "./onslaught-data.ts";
import { normalizeTheater } from "./theater-data.ts";
import { normalizeAbyss } from "./abyss-data.ts";
import { normalizeStarrailChallenge, type StarrailChallengeMode } from "./starrail-challenge-data.ts";
import { normalizeShiyu, type ShiyuPeriod } from "./shiyu-data.ts";
import { normalizeDeadlyAssault } from "./deadly-assault-data.ts";
import { genshinCardPage, normalizeGenshinCard } from "./gcg-data.ts";
import { normalizeBangbooDetails } from "./bangboo-data.ts";
import { AtlasSnapshotReset, discoverAtlasDataDirectory } from "./snapshot-pointer.ts";
import { discoverRuntimeAtlasDataDirectory, LegacyAtlasSourceConflict } from "./legacy-atlas-directory.ts";
import { rebuildLegacyAtlasIndex } from "./rebuild-legacy-index.ts";
import equipmentAliasData from "./equipment-aliases.json";
import legacyCharacterSetAliasData from "./legacy-character-set-aliases.json";
import { zzzCharacterAliases } from "./zzz-role-names.ts";

export { defaultAtlasLocale, parseAtlasLocale } from "./locale.ts";

export const gameNames = { gi: "原神", hsr: "星铁", zzz: "绝区零" } as const;
export type Game = keyof typeof gameNames;

const shortcutIdentityAgeNs = 100_000_000n;

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
const kinds = ["character", "equipment", "set", "bangboo", "monster", "achievement", "gcg"] as const;
type StandardKind = typeof kinds[number];
type Kind = StandardKind | "challenge";

function pageFor(game: Game, kind: StandardKind): { id: string; name: string } | undefined {
  switch (kind) {
    case "character": return { id: "character", name: "角色" };
    case "equipment": return equipmentPages[game];
    case "set": return setPages[game];
    case "achievement": return achievementPage;
    case "bangboo": return game === "zzz" ? bangbooPage : undefined;
    case "gcg": return game === "gi" ? genshinCardPage : undefined;
    case "monster": return { id: "monster", name: "敌人" };
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

export interface MonsterDetails {
  readonly game: Game;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly artwork?: string;
}

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
  readonly rebuilt?: true;
}

interface Snapshot extends Catalog {
  readonly map: Buffer;
  readonly mapIdentity: string;
  readonly legacy: boolean;
  readonly root: string;
  readonly version: number | null;
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

function score(entry: AtlasEntry, key: string, literal: string): number {
  const name = compareKey(entry.name);
  if (entry.id === literal || entry.id === key || name === key) return 3;
  if (name.startsWith(key)) return 2;
  return name.includes(key) ? 1 : 0;
}

function exactName(value: string): string {
  return value.trim().normalize("NFKC").toLowerCase();
}

function legacyAliasKey(value: string): string {
  return exactName(value).replace(/[\s·・「」『』"'“”‘’【】\[\]()（）]/gu, "");
}

function indexAliases(entries: Readonly<Record<string, readonly string[] | string>>, normalize = exactName) {
  const aliases = new Map<string, Set<string>>();
  for (const [canonical, terms] of Object.entries(entries)) {
    for (const term of typeof terms === "string" ? terms.split(",") : terms) {
      const key = normalize(term);
      if (!key) continue;
      const names = aliases.get(key) ?? new Set();
      names.add(compareKey(canonical));
      aliases.set(key, names);
    }
  }
  return aliases;
}

const equipmentAliases = new Map(
  Object.entries(equipmentAliasData).map(([game, entries]) => [game as Game, indexAliases(entries)]),
);

const legacyCharacterSetAliases = new Map(
  Object.entries(legacyCharacterSetAliasData).map(([game, kinds]) => [game as Game, new Map(
    Object.entries(kinds).map(([kind, entries]) => [kind as Kind, indexAliases(entries, legacyAliasKey)]),
  )]),
);

function findMatches<K extends Kind>(catalog: Catalog, kinds: readonly K[], query: string, game?: Game, exact = false, includePartial = false) {
  const literal = exactName(query);
  const key = exact ? literal : compareKey(query);
  if (!key) return [];
  const legacyKey = legacyAliasKey(literal);
  const matches = catalog.pages.flatMap((page) => {
    const kind = kinds.find((kind) => kind === page.kind);
    if (!kind || (game && page.game !== game)) return [];
    const aliasTarget = page.game === "zzz" && kind === "character" ? zzzCharacterAliases.get(literal) : undefined;
    const weaponNames = kind === "equipment" ? equipmentAliases.get(page.game)?.get(literal) : undefined;
    const legacyNames = legacyCharacterSetAliases.get(page.game)?.get(kind)?.get(legacyKey);
    return page.entries.map((entry) => {
      const direct = exact ? (exactName(entry.name) === key ? 3 : 0) : score(entry, key, literal);
      const trailblazer = kind === "character" ? starRailTrailblazerName(entry) : undefined;
      // A verified name ranks below an exact record name and above a partial match.
      const alias = (aliasTarget?.id === entry.id && aliasTarget.name === entry.name) ||
        (trailblazer !== undefined && (literal === "开拓者" || exactName(trailblazer) === literal)) ||
        weaponNames?.has(compareKey(entry.name)) ||
        legacyNames?.has(compareKey(entry.name)) ||
        (kind === "set" && page.game === "gi" && literal === "冰封迷途的勇士" &&
          entry.id === "14001" && entry.name === "冰风迷途的勇士");
      return { kind, entry, score: alias ? Math.max(direct, 2.5) : direct };
    });
  });
  const best = matches.reduce((best, match) => Math.max(best, match.score), 0);
  if (best > 0 && best <= 2 && includePartial) return matches.filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.entry.name.length - right.entry.name.length ||
      left.entry.name.localeCompare(right.entry.name, "zh-Hans-CN"));
  return best > 0 ? matches.filter((match) => match.score === best) : [];
}

function findEntries(catalog: Catalog, kind: Kind, query: string, game?: Game): AtlasEntry[] {
  return findMatches(catalog, [kind], query, game).map(({ entry }) => entry);
}

export type TraditionalLookup = "search" | "name" | "equipment" | "weapon" | "character" | "character-search" | "bare";

export function findTraditionalEntries(catalog: Catalog, query: string, game?: Game, mode: TraditionalLookup = "search") {
  if (mode === "weapon") return findMatches(catalog, ["equipment"], query, game, true);
  if (mode === "bare") {
    const weapons = findMatches(catalog, ["equipment"], query, game, true);
    return weapons.length ? weapons : findMatches(catalog, ["character", "set"], query, game, true);
  }
  if (mode === "equipment") return findMatches(catalog, ["equipment", "set"], query, game, true);
  if (mode === "character") return findMatches(catalog, ["character"], query, game, true);
  if (mode === "character-search") {
    const exact = findMatches(catalog, ["character"], query, game, true);
    return exact.length || Array.from(query.trim()).length < 2 ? exact : findMatches(catalog, ["character"], query, game, false, true);
  }
  const pages = catalog.pages.filter((page) => page.kind !== "challenge" || page.challengeMode?.id === "leyline");
  const existing = findMatches({ ...catalog, pages }, ["character", "equipment", "set", "bangboo", "monster", "challenge"],
    query, game, mode === "name", mode === "search");
  const cards = findMatches(catalog, ["gcg"], query, game, mode === "name", mode === "search");
  return cards.length && (cards[0]?.score ?? 0) > (existing[0]?.score ?? 0) ? cards : existing;
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

export function findMonsters(catalog: Catalog, query: string, game?: Game): AtlasEntry[] {
  return findEntries(catalog, "monster", query, game);
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

function artifactName(list: Record<string, unknown>, locale: AtlasLocale): string {
  const names = new Set(Object.values(object(list.set)).map((affix) =>
    label(object(object(affix).name)[locale])).filter(Boolean));
  return names.size === 1 ? [...names][0] ?? "" : "";
}

export function createAtlasRuntimeCatalog(atlasRoot: string, override?: string, locale = defaultAtlasLocale) {
  return override ? createAtlasCatalog(override, undefined, false, locale)
    : createAtlasCatalog(join(atlasRoot, "data"), atlasRoot, true, locale);
}

export function createAtlasCatalog(directory: string, publicationRoot?: string, legacyFallback = false, locale = defaultAtlasLocale) {
  const configuredRoot = resolve(directory);
  const publishedRoot = publicationRoot && resolve(publicationRoot);
  const entryRoots = new WeakMap<AtlasEntry, string>();
  let snapshot: Snapshot | undefined;
  let rebuiltAt = 0;
  let reading: Promise<Catalog> | undefined;
  let checkingShortcuts: Promise<Catalog> | undefined;

  async function locate() {
    if (publishedRoot && legacyFallback) return discoverRuntimeAtlasDataDirectory(publishedRoot, locale);
    const located = publishedRoot ? await discoverAtlasDataDirectory(publishedRoot)
      : { root: await realpath(configuredRoot), version: null };
    return { ...located, legacy: false };
  }

  async function read(shortcut = false): Promise<Catalog> {
    try {
      const { root, version, legacy } = await locate();
      if (snapshot?.version && (version === null || version < snapshot.version)) {
        throw new Error("图鉴发布指针丢失或版本倒退。");
      }
      const mapPath = join(root, "map.json");
      const marker = await lstat(mapPath, { bigint: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || version !== null) throw error;
        return undefined;
      });
      const info = marker?.isSymbolicLink() && version === null ? await stat(mapPath, { bigint: true }) : marker;
      if (version !== null && !info?.isFile()) throw new Error("已发布图鉴索引须为实体文件。");
      const mapIdentity = info ? [info.dev, info.ino, info.ctimeNs, info.mtimeNs, info.size].join(":") : "rebuilt";
      // Recent writes can share a filesystem clock tick. Compare bytes until they are outside that window.
      // Explicit queries always compare bytes.
      const settledIdentity = info ? info.ctimeNs < BigInt(Date.now()) * 1_000_000n - shortcutIdentityAgeNs
        : Date.now() < rebuiltAt + 10_000;
      if (shortcut && settledIdentity && snapshot && !snapshot.stale && root === snapshot.root &&
          version === snapshot.version && legacy === snapshot.legacy && mapIdentity === snapshot.mapIdentity) {
        return { pages: snapshot.pages, stale: false, ...(snapshot.rebuilt && { rebuilt: true }) };
      }
      const map = info ? await readFile(mapPath) : await rebuildLegacyAtlasIndex(root, locale);
      if (!info) rebuiltAt = Date.now();
      if (!snapshot || snapshot.stale || root !== snapshot.root || version !== snapshot.version ||
          legacy !== snapshot.legacy || (!info) !== (snapshot.rebuilt === true) || !map.equals(snapshot.map)) {
        const source = object(JSON.parse(map.toString("utf8")));
        const pages: AtlasPage[] = [];
        const previousPages = info && snapshot?.legacy === legacy && !snapshot.rebuilt && (!legacy || snapshot.root === root)
          ? snapshot.pages : [];
        let stale = false;
        for (const game of Object.keys(gameNames) as Game[]) {
          const gameBlock = object(object(source.games)[game]);
          const rawPages = object(atlasLocaleBlock(gameBlock, locale).pages);
          const standardPages = kinds.flatMap((kind) => {
            const page = pageFor(game, kind);
            return page ? [{ ...page, kind, challengeMode: undefined }] : [];
          });
          const challengePages = challengeModes.filter((mode) => mode.game === game)
            .map((mode) => ({ id: mode.id, name: mode.name, kind: "challenge" as const, challengeMode: mode }));
          for (const { id: pageId, name, kind, challengeMode } of [...standardPages, ...challengePages]) {
            const previous = previousPages.find((page) =>
              page.game === game && page.kind === kind && page.challengeMode?.id === challengeMode?.id);
            const value = rawPages[pageId];
            if (value === undefined && !previous) continue;

            try {
              const page = readPage(game, kind, name, value);
              for (const entry of page.entries) entryRoots.set(entry, root);
              if (kind === "set" && game === "gi") {
                const entries: AtlasEntry[] = [];
                for (const entry of page.entries) {
                  const name = artifactName(object((await readContent(entry, pageId)).list), locale);
                  if (!name) throw new Error("圣遗物套装名称缺失或不一致。");
                  const artifact = { ...entry, name };
                  entryRoots.set(artifact, root);
                  entries.push(artifact);
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
        if (!pages.length || ((version !== null || !info) && stale)) throw new Error("图鉴索引缺少可用分类。");
        snapshot = { map, mapIdentity, root, version, legacy, pages, stale, ...(!info && { rebuilt: true }) };
      } else if (mapIdentity !== snapshot.mapIdentity) {
        snapshot = { ...snapshot, mapIdentity };
      }
      return { pages: snapshot.pages, stale: snapshot.stale, ...(snapshot.rebuilt && { rebuilt: true }) };
    } catch (error) {
      if (error instanceof AtlasSnapshotReset) {
        snapshot = undefined;
        throw error;
      }
      if (snapshot && !snapshot.rebuilt && !snapshot.legacy && !(error instanceof LegacyAtlasSourceConflict)) {
        return { pages: snapshot.pages, stale: true };
      }
      throw error;
    }
  }

  async function readItem(entry: AtlasEntry, pageId: string) {
    try {
      const root = entryRoots.get(entry) ?? (publishedRoot ? snapshot?.root : undefined) ?? (await locate()).root;
      const file = await realpath(resolve(root, entry.path));
      const local = relative(root, file);
      if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) return;
      const item = object(JSON.parse(await readFile(file, "utf8")));
      const meta = object(item.meta);
      if (meta.gameId !== entry.game || meta.pageId !== pageId || meta.recordId !== entry.id ||
          meta.version !== entry.version || (meta.locale !== undefined && parseAtlasLocale(meta.locale) !== locale)) return;
      return { content: object(item.content), meta };
    } catch {
      return undefined;
    }
  }

  async function readContent(entry: AtlasEntry, pageId: string): Promise<Record<string, unknown>> {
    return (await readItem(entry, pageId))?.content ?? {};
  }

  async function monsterDetails(entry: AtlasEntry): Promise<MonsterDetails | undefined> {
    const item = await readItem(entry, "monster");
    const detail = object(item?.content.detail);
    if (!item || label(detail.name) !== entry.name) return;
    const description = effectText(detail.desc);
    if (!description) return;
    return { game: entry.game, name: entry.name, version: entry.version, description,
      artwork: galleryArtwork(item.meta.images, entry.game)() };
  }

  function relatedRecords(entry: AtlasEntry, catalog: Catalog, kind: "character" | "monster") {
    const root = entryRoots.get(entry);
    return new Map((catalog.pages.find((page) => page.game === entry.game && page.kind === kind)?.entries ?? [])
      .filter((record) => root && entryRoots.get(record) === root)
      .map((record) => [record.id, record]));
  }

  function exactEnemyLookup(entry: AtlasEntry, catalog: Catalog) {
    const enemies = relatedRecords(entry, catalog, "monster");
    const pending = new Map<string, Promise<MonsterDetails | undefined>>();
    return (id: string, name: string) => {
      const enemy = enemies.get(id);
      if (!enemy || (name && enemy.name !== name)) return Promise.resolve(undefined);
      const known = pending.get(id);
      if (known) return known;
      const details = monsterDetails(enemy);
      pending.set(id, details);
      return details;
    };
  }

  function starrailEnemyLookup(entry: AtlasEntry, catalog: Catalog) {
    const enemies = relatedRecords(entry, catalog, "monster");
    const pending = new Map<string, ReturnType<typeof readItem>>();
    return async (id: string) => {
      // Removing the difficulty suffix only locates a candidate. Both source sheets must name the exact child.
      const enemy = enemies.get(id) ?? (/^\d{9}$/u.test(id) ? enemies.get(id.slice(0, -2)) : undefined);
      if (!enemy) return;
      let reading = pending.get(enemy.id);
      if (!reading) {
        reading = readItem(enemy, "monster");
        pending.set(enemy.id, reading);
      }
      const item = await reading;
      if (!item) return;
      const { detail: rawDetail, list: rawList } = item.content;
      const detail = object(rawDetail);
      const list = object(rawList);
      if (String(detail.id) !== enemy.id || label(detail.name) !== enemy.name) return;
      if (enemy.id !== id && !(Array.isArray(list.child) && list.child.includes(Number(id)) &&
        Array.isArray(detail.child) && detail.child.some((child) => object(child).id === Number(id)))) return;
      return { name: enemy.name, description: effectText(detail.desc), artwork: galleryArtwork(item.meta.images, "hsr")() };
    };
  }

  return {
    assetRoot(entry: AtlasEntry): string {
      return entryRoots.get(entry) ?? (publishedRoot ? snapshot?.root : undefined) ?? configuredRoot;
    },
    locale,
    async statusSource() {
      const root = snapshot?.root ?? await locate().then(({ root }) => root, () => configuredRoot);
      const bases = basename(root) === "data" ? [root, dirname(root)] : [root];
      const galleries = await Promise.all(bases.map(base => lstat(join(base, "gallery")).catch(() => undefined)));
      return { root, galleryReady: galleries.some(info => info?.isDirectory()) };
    },
    read(): Promise<Catalog> {
      return reading ??= (checkingShortcuts ? checkingShortcuts.then(() => read(), () => read()) : read())
        .finally(() => { reading = undefined; });
    },
    readForEquipmentShortcut(): Promise<Catalog> {
      return reading ?? (checkingShortcuts ??= read(true).finally(() => { checkingShortcuts = undefined; }));
    },
    async characterRarity(character: Character): Promise<string> {
      if (character.game !== "zzz") return character.rarity;
      const { rank } = object((await readContent(character, "character")).list);
      return rank === 2 ? "" : zzzRarity(rank);
    },
    async genshinCardDetails(entry: AtlasEntry) {
      if (entry.game !== "gi") return;
      const item = await readItem(entry, genshinCardPage.id);
      if (item) return normalizeGenshinCard(entry.id, entry.version, item.content, item.meta.images);
    },
    async roleDetails(character: Character): Promise<RoleDetails | undefined> {
      const item = await readItem(character, "character");
      if (!item) return;
      const { rank } = object(item.content.list);
      const rarity = character.game === "zzz" ? rank === 2 ? "" : zzzRarity(rank) : character.rarity;
      return normalizeRoleDetails(character, item.content, rarity, item.meta.images, item.meta.materialNames);
    },
    async weaponDetails(entry: AtlasEntry) {
      const item = await readItem(entry, equipmentPages[entry.game].id);
      if (item) return normalizeWeapon(entry, item.content, item.meta.images);
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
    async setDetails(entry: AtlasEntry) {
      const item = await readItem(entry, setPages[entry.game].id);
      if (item) return normalizeSet(entry, item.content, item.meta.images);
    },
    async achievementCategoryArtwork(entry: AtlasEntry): Promise<string | undefined> {
      if (entry.game !== "gi") return;
      const item = await readItem(entry, achievementPage.id);
      if (!item) return;
      const list = object(item.content.list);
      const icon = label(list.icon);
      if (label(list.name) !== entry.name || !/^UI_AchievementIcon_[A-Za-z0-9_]+$/u.test(icon)) return;
      const artwork = galleryArtwork(item.meta.images, entry.game)("icon");
      if (artwork === `gallery/gi/${icon}.webp`) return artwork;
    },
    async challengeFacts(entry: AtlasEntry, mode: ChallengeMode) {
      const content = await readContent(entry, mode.id);
      return readChallengeFacts(mode, content);
    },
    async onslaughtDetails(entry: AtlasEntry) {
      const item = await readItem(entry, "leyline");
      if (item) return normalizeOnslaught(entry, item.content, item.meta.images);
    },
    async theaterDetails(entry: AtlasEntry, catalog: Catalog, current = false) {
      if (entry.game !== "gi") return;
      const item = await readItem(entry, "rolecombat");
      if (!item) return;
      const characters = relatedRecords(entry, catalog, "character");
      return normalizeTheater(entry, item.content, item.meta.images, {
        async character(id) {
          const character = characters.get(id);
          if (!character) return;
          const details = await readItem(character, "character");
          return { name: character.name, artwork: galleryArtwork(details?.meta.images, "gi")("icon", "detail.icon") };
        },
        enemy: exactEnemyLookup(entry, catalog),
      }, current);
    },
    async abyssDetails(entry: AtlasEntry, catalog: Catalog, current = false) {
      if (entry.game !== "gi") return;
      const item = await readItem(entry, "tower");
      if (item) return normalizeAbyss(entry, item.content, item.meta.images, exactEnemyLookup(entry, catalog), current);
    },
    async starrailChallengeDetails(entry: AtlasEntry, catalog: Catalog, mode: StarrailChallengeMode, current = false) {
      if (entry.game !== "hsr") return;
      const item = await readItem(entry, mode.id);
      if (item) return normalizeStarrailChallenge(entry, mode, item.content, item.meta.images, starrailEnemyLookup(entry, catalog), current);
    },
    async shiyuDetails(entry: AtlasEntry, catalog: Catalog, period?: ShiyuPeriod) {
      if (entry.game !== "zzz") return;
      const item = await readItem(entry, "shiyu");
      if (item) return normalizeShiyu(entry, item.content, item.meta.images, exactEnemyLookup(entry, catalog), period);
    },
    async deadlyAssaultDetails(entry: AtlasEntry, catalog: Catalog, current = false) {
      if (entry.game !== "zzz") return;
      const item = await readItem(entry, "boss");
      if (item) return normalizeDeadlyAssault(entry, item.content, item.meta.images, exactEnemyLookup(entry, catalog), current);
    },
    monsterDetails,
    async monsterDescription(entry: AtlasEntry): Promise<string> {
      return (await monsterDetails(entry))?.description ?? "";
    },
    async bangbooDetails(entry: AtlasEntry) {
      if (entry.game !== "zzz") return;
      const item = await readItem(entry, bangbooPage.id);
      if (item) return normalizeBangbooDetails(entry, item.content, item.meta.images);
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
