import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
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
import { referenceContent } from "./reference-data.ts";
import { AtlasSnapshotReset, discoverAtlasDataDirectory } from "./snapshot-pointer.ts";
import { discoverRuntimeAtlasDataDirectory, LegacyAtlasSourceConflict } from "./legacy-atlas-directory.ts";
import { rebuildLegacyAtlasIndex } from "./rebuild-legacy-index.ts";
import equipmentAliasData from "./equipment-aliases.json";
import legacyCharacterSetAliasData from "./legacy-character-set-aliases.json";
import { zzzCharacterAliases } from "./zzz-role-names.ts";

export { defaultAtlasLocale, parseAtlasLocale } from "./locale.ts";

export const gameNames = { gi: $t("catalog.text_d1597c51ed"), hsr: $t("catalog.text_a2927891f0"), zzz: $t("catalog.text_b1110352c9") } as const;
export type Game = keyof typeof gameNames;

const shortcutIdentityAgeNs = 100_000_000n;

const equipmentPages = {
  gi: { id: "weapon", name: $t("catalog.text_4fe131173e") },
  hsr: { id: "lightcone", name: $t("catalog.text_e733238b28") },
  zzz: { id: "weapon", name: $t("catalog.text_2ce0392ca1") },
} as const;

const setPages = {
  gi: { id: "artifact", name: $t("catalog.text_fc2ee58f3d") },
  hsr: { id: "relicset", name: $t("catalog.text_6239fc646e") },
  zzz: { id: "equipment", name: $t("catalog.text_d245c1825d") },
} as const;

const achievementPage = { id: "achievement/achievement", name: $t("catalog.text_52b0e1703d") } as const;
const bangbooPage = { id: "bangboo", name: $t("catalog.text_aa46a7c35b") } as const;
const kinds = ["character", "equipment", "set", "bangboo", "monster", "achievement", "gcg"] as const;
type StandardKind = typeof kinds[number];
type Kind = StandardKind | "challenge" | "reference";

function pageFor(game: Game, kind: StandardKind): { id: string; name: string } | undefined {
  switch (kind) {
    case "character": return { id: "character", name: $t("catalog.text_c47b54e84e") };
    case "equipment": return equipmentPages[game];
    case "set": return setPages[game];
    case "achievement": return achievementPage;
    case "bangboo": return game === "zzz" ? bangbooPage : undefined;
    case "gcg": return game === "gi" ? genshinCardPage : undefined;
    case "monster": return { id: "monster", name: $t("catalog.text_40a2cbbcce") };
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

export interface ReferenceDetails {
  readonly game: Game;
  readonly name: string;
  readonly version: string;
  readonly category: string;
  readonly artwork?: string;
  readonly intro: string;
  readonly sections: readonly { title: string; content: string }[];
}

export interface MonsterDetails {
  readonly game: Game;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly artwork?: string;
  readonly sections?: ReferenceDetails["sections"];
}

interface AtlasPage {
  readonly game: Game;
  readonly version: string;
  readonly sampled: boolean;
  readonly kind: Kind;
  readonly name: string;
  readonly entries: readonly AtlasEntry[];
  readonly challengeMode?: ChallengeMode;
  readonly referenceId?: string;
  readonly sourceUrl?: string;
  readonly achievementCategories?: readonly AchievementCategory[];
}

export type ReadAtlasCharacterAliases = (game: "gi" | "hsr") => Promise<ReadonlyMap<string, string>>;

interface Catalog {
  readonly pages: readonly AtlasPage[];
  readonly stale: boolean;
  readonly rebuilt?: true;
  readonly characterAliases?: ReadonlyMap<Game, ReadonlyMap<string, string>>;
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
    throw new Error($t("catalog.text_82a3071aa1", { "name": name }));
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
      throw new Error($t("catalog.text_2c2de1f14a", { "name": name }));
    }
    ids.add(id);
    entries.push({ game, id, name: title, version, path, rarity: label(record.rarity) });
  }
  return { game, kind, name, version, sampled: page.sampled === true, entries };
}

function score(entry: AtlasEntry, key: string, literal: string): number {
  const name = compareKey(entry.name);
  if (entry.id === literal || entry.id === key) return 3;
  return nameScore(name, key);
}

function nameScore(name: string, key: string): number {
  if (name === key) return 3;
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

// Fixed Miao 28607618 names and independent IDs corresponding to the public enhancement records.
const starRailProRoles = [
  { id: "2004", name: "瓦尔特Pro", baseId: "1004", baseName: "瓦尔特" },
  { id: "2005", name: "卡芙卡Pro", baseId: "1005", baseName: "卡芙卡" },
  { id: "2006", name: "银狼Pro", baseId: "1006", baseName: "银狼" },
  { id: "2102", name: "希儿Pro", baseId: "1102", baseName: "希儿" },
  { id: "2205", name: "刃Pro", baseId: "1205", baseName: "刃", variantSkills: [8] },
  { id: "2212", name: "镜流Pro", baseId: "1212", baseName: "镜流", variantSkills: [9] },
  { id: "2217", name: "藿藿Pro", baseId: "1217", baseName: "藿藿" },
  { id: "2306", name: "花火Pro", baseId: "1306", baseName: "花火" },
  { id: "2307", name: "黑天鹅Pro", baseId: "1307", baseName: "黑天鹅" },
  { id: "2310", name: "流萤Pro", baseId: "1310", baseName: "流萤", variantSkills: [8, 9] },
] as const;
type StarRailProRole = (typeof starRailProRoles)[number];
const starRailProSources = new WeakMap<AtlasEntry, { base: AtlasEntry; role: StarRailProRole }>();

function proEntries(page: AtlasPage, role: StarRailProRole): readonly AtlasEntry[] {
  // Prefer a real exported record if the data source begins publishing the enhancement separately.
  if (page.entries.some(({ id, name }) => id === role.id || exactName(name) === exactName(role.name))) return page.entries;
  const base = page.entries.find(({ id, name }) => id === role.baseId && name === role.baseName);
  if (!base) return page.entries;
  const enhanced = { ...base, id: role.id, name: role.name };
  starRailProSources.set(enhanced, { base, role });
  return [...page.entries, enhanced];
}

function starRailProItem(variant: StarRailProRole, content: Record<string, unknown>, images: unknown) {
  const detail = object(content.detail);
  if (label(detail.name) !== variant.baseName) return;
  const enhancement = object(object(detail.enhanced)["1"]);
  const ranks = object(enhancement.ranks);
  const skillTrees = object(enhancement.skill_trees);
  const skills = object(enhancement.skills);
  // Do not present a partial or unrelated enhancement as the archived Pro character.
  const baseSkillId = (10_000 + Number(variant.baseId)) * 100;
  const variantSkills = "variantSkills" in variant ? variant.variantSkills : [];
  const skillIds = [1, 2, 3, 4, 7, ...variantSkills].map(suffix => baseSkillId + suffix);
  if (!skillIds.every(id => object(skills[id]).id === id && label(object(skills[id]).name)) ||
      ![1, 2, 3, 4, 5, 6].every(rank => label(object(ranks[rank]).name)) ||
      !["point06", "point07", "point08"].every(point => {
        const trace = object(object(skillTrees[point])["1"]);
        return trace.point_type === 3 && label(trace.point_name);
      })) return;
  const sourcePrefix = "detail.enhanced.1.";
  const fields = Array.isArray(images) ? images : Object.values(object(images));
  const covered = /^(?:skills|skill_trees|ranks)\./u;
  const enhancedImages = fields.flatMap((raw) => {
    const image = object(raw);
    const fieldPath = label(image.fieldPath);
    if (fieldPath.startsWith(sourcePrefix)) {
      const field = fieldPath.slice(sourcePrefix.length);
      return covered.test(field) ? [{ ...image, fieldPath: `detail.${field}` }] : [];
    }
    return fieldPath.startsWith("detail.") && covered.test(fieldPath.slice(7)) ? [] : [image];
  });
  return {
    content: { ...content, detail: { ...detail, ranks, skill_trees: skillTrees, skills } },
    images: enhancedImages,
  };
}

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
    const sharedAliases = kind === "character" ? catalog.characterAliases?.get(page.game) : undefined;
    const sharedTarget = sharedAliases?.get(literal.replace(/[\s·・•]/gu, ""));
    const legacyNames = sharedAliases
      ? sharedTarget ? new Set([compareKey(sharedTarget)]) : undefined
      : legacyCharacterSetAliases.get(page.game)?.get(kind)?.get(legacyKey);
    const pro = page.game === "hsr" && kind === "character" ? starRailProRoles.find(({ id, name }) =>
      literal === id || literal === exactName(name) || legacyNames?.has(compareKey(name))) : undefined;
    return (pro ? proEntries(page, pro) : page.entries).map((entry) => {
      const matchedPro = pro && entry.id === pro.id && entry.name === pro.name;
      const exactProId = matchedPro && literal === entry.id;
      const named = exact ? (exactName(entry.name) === key || exactProId ? 3 : 0) : score(entry, key, literal);
      const filename = includePartial ? basename(entry.path, ".json") : "";
      const legacyFile = filename.endsWith(`__${entry.id}`) && compareKey(filename) === key;
      const direct = legacyFile ? 3 : named;
      if (kind === "reference") {
        const stem = filename.replace(/__[a-z0-9_.+-]+$/iu, "");
        return { kind, entry, score: Math.max(direct, nameScore(compareKey(stem), key)) };
      }
      const trailblazer = kind === "character" ? starRailTrailblazerName(entry) : undefined;
      // A verified name ranks below an exact record name and above a partial match.
      const alias = (aliasTarget?.id === entry.id && aliasTarget.name === entry.name) ||
        (trailblazer !== undefined && (literal === "开拓者" || exactName(trailblazer) === literal)) ||
        weaponNames?.has(compareKey(entry.name)) ||
        legacyNames?.has(compareKey(entry.name)) ||
        (kind === "set" && page.game === "gi" && literal === "冰封迷途的勇士" &&
          entry.id === "14001" && entry.name === "冰风迷途的勇士");
      // In the archived alias table a Pro alias registered after its base takes precedence.
      return { kind, entry, score: alias ? Math.max(direct, matchedPro ? 2.75 : 2.5) : direct };
    });
  });
  // A recognized playable-role name/alias expresses character intent in mixed lookup.
  // Exact playable names still outrank aliases, and explicit non-character queries never enter this branch.
  const candidates = matches.some(match => match.kind === "character" && match.score >= 2.5)
    ? matches.filter(match => match.kind === "character") : matches;
  const best = candidates.reduce((best, match) => Math.max(best, match.score), 0);
  if (best > 0 && best <= 2 && includePartial) return candidates.filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.entry.name.length - right.entry.name.length ||
      left.entry.name.localeCompare(right.entry.name, "zh-Hans-CN"));
  return best > 0 ? candidates.filter((match) => match.score === best) : [];
}

function findEntries(catalog: Catalog, kind: Kind, query: string, game?: Game): AtlasEntry[] {
  return findMatches(catalog, [kind], query, game).map(({ entry }) => entry);
}

export type TraditionalLookup = "search" | "name" | "equipment" | "weapon" | "character" | "character-search" | "bare";

export function findTraditionalEntries(catalog: Catalog, query: string, game?: Game, mode: TraditionalLookup = "search") {
  if (mode === "weapon") return findMatches(catalog, ["equipment"], query, game, true);
  if (mode === "bare") {
    const characters = findMatches(catalog, ["character"], query, game, true);
    if (characters.some(({ score }) => score >= 2.5)) return characters;
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
  const characterIntent = existing[0]?.kind === "character" && existing[0].score >= 2.5;
  const matches = !characterIntent && cards.length && (cards[0]?.score ?? 0) > (existing[0]?.score ?? 0) ? cards : existing;
  if (mode !== "search" || (matches[0]?.score ?? 0) >= 2.5) return matches;
  const references = findMatches(catalog, ["reference"], query, game, false, true);
  return (references[0]?.score ?? 0) > (matches[0]?.score ?? 0) ? references : matches;
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

const detailOrder = { character: 0, equipment: 1, challenge: 2, set: 3 } as const;
type DetailKind = keyof typeof detailOrder;
const displayTextField = /^(?:name|title|text|effect|story|background|(?:[a-z]+_)?desc(?:ription)?|brief|content)$/iu;

function detailMatches(value: unknown, query: string, field = "", depth = 0): boolean {
  if (typeof value === "string") {
    return displayTextField.test(field) && compareKey(value.replace(/<[^>]*>/gu, "").replace(/\\n/gu, "")).includes(query);
  }
  if (depth >= 12 || !value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, text]) =>
    detailMatches(text, query, /^\d+$/u.test(key) ? field : key, depth + 1));
}

const weaponTypes = new Map([
  ["WEAPON_SWORD_ONE_HAND", $t("catalog.text_672bf41f03")], ["WEAPON_CLAYMORE", $t("catalog.text_3db03533c2")],
  ["WEAPON_CATALYST", $t("catalog.text_8f83d07fae")], ["WEAPON_BOW", $t("catalog.text_d97da89d3d")], ["WEAPON_POLE", $t("catalog.text_b4cc81a2da")],
]);

const lightConePaths = new Map([
  ["Warrior", $t("catalog.text_85a5719200")], ["Rogue", $t("catalog.text_89ae343575")], ["Mage", $t("catalog.text_4807b62b3a")],
  ["Warlock", $t("catalog.text_135fd7b0a1")], ["Shaman", $t("catalog.text_b28b5f46a0")], ["Knight", $t("catalog.text_d55d4d5989")],
  ["Priest", $t("catalog.text_18db236249")], ["Memory", $t("catalog.text_7a6335b379")], ["Elation", $t("catalog.text_17f4b35418")],
]);

const wEngineSpecialties = new Map([
  [1, $t("catalog.text_c9ffdabf6a")], [2, $t("catalog.text_092a6b7674")], [3, $t("catalog.text_428fb8bfee")], [4, $t("catalog.text_9aa79fc650")],
  [5, $t("catalog.text_92d50bd5df")], [6, $t("catalog.text_5864750f87")], [7, $t("catalog.text_7ad730d9ed")],
]);

function zzzRarity(rank: unknown): string {
  switch (rank) {
    case 2: return $t("catalog.text_69a58e24ce");
    case 3: return $t("catalog.text_e6c2ad53f8");
    case 4: return $t("catalog.text_4456d1cdc8");
    default: return "";
  }
}

function artifactName(list: Record<string, unknown>, locale: AtlasLocale): string {
  const names = new Set(Object.values(object(list.set)).map((affix) =>
    label(object(object(affix).name)[locale])).filter(Boolean));
  return names.size === 1 ? [...names][0] ?? "" : "";
}

export function createAtlasRuntimeCatalog(atlasRoot: string, override?: string, locale = defaultAtlasLocale,
  readCharacterAliases?: ReadAtlasCharacterAliases) {
  return override ? createAtlasCatalog(override, undefined, false, locale, readCharacterAliases)
    : createAtlasCatalog(join(atlasRoot, "data"), atlasRoot, true, locale, readCharacterAliases);
}

export function createAtlasCatalog(directory: string, publicationRoot?: string, legacyFallback = false, locale = defaultAtlasLocale,
  readCharacterAliases?: ReadAtlasCharacterAliases) {
  const configuredRoot = resolve(directory);
  const publishedRoot = publicationRoot && resolve(publicationRoot);
  const entryRoots = new WeakMap<AtlasEntry, string>();
  let snapshot: Snapshot | undefined;
  let rebuiltAt = 0;
  let reading: Promise<Catalog> | undefined;
  let checkingShortcuts: Promise<Catalog> | undefined;

  async function withCharacterAliases(catalog: Catalog): Promise<Catalog> {
    if (!readCharacterAliases) return catalog;
    const tables = await Promise.all((["gi", "hsr"] as const).map(async game => {
      const aliases = await readCharacterAliases(game).catch(() => undefined);
      return aliases ? [[game, aliases] as const] : [];
    }));
    return { ...catalog, characterAliases: new Map(tables.flat()) };
  }

  async function locate() {
    if (publishedRoot && legacyFallback) return discoverRuntimeAtlasDataDirectory(publishedRoot, locale);
    const located = publishedRoot ? await discoverAtlasDataDirectory(publishedRoot)
      : { root: await realpath(configuredRoot), version: null };
    return { ...located, legacy: false };
  }

  async function materializePages(map: Buffer, root: string, previousPages: readonly AtlasPage[] = []) {
    const source = object(JSON.parse(map.toString("utf8")));
    const pages: AtlasPage[] = [];
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
      const knownIds = new Set([...standardPages, ...challengePages].map(({ id }) => id));
      // An existing export can contain additional pages without changing the default download scope.
      for (const [pageId, value] of Object.entries(rawPages)) {
        if (knownIds.has(pageId) || !/^[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)*$/iu.test(pageId)) continue;
        const raw = object(value);
        const name = label(raw.folder) || label(raw.title) || pageId;
        if (name.length > 96 || /[\p{Cc}\p{Cf}]/u.test(name)) continue;
        try {
          const page = readPage(game, "reference", name, raw);
          for (const entry of page.entries) entryRoots.set(entry, root);
          pages.push({ ...page, referenceId: pageId });
        } catch {
          // Optional export pages do not invalidate the main categories.
        }
      }
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
              if (!name) throw new Error($t("catalog.text_668f5712af"));
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
    return { pages, stale };
  }

  async function read(shortcut = false): Promise<Catalog> {
    try {
      const { root, version, legacy } = await locate();
      if (snapshot?.version && (version === null || version < snapshot.version)) {
        throw new Error($t("catalog.text_3c8cb9d9f6"));
      }
      const mapPath = join(root, "map.json");
      const marker = await lstat(mapPath, { bigint: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || version !== null) throw error;
        return undefined;
      });
      const info = marker?.isSymbolicLink() && version === null ? await stat(mapPath, { bigint: true }) : marker;
      if (version !== null && !info?.isFile()) throw new Error($t("catalog.text_abaccecdde"));
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
        const previousPages = info && snapshot?.legacy === legacy && !snapshot.rebuilt && (!legacy || snapshot.root === root)
          ? snapshot.pages : [];
        const { pages, stale } = await materializePages(map, root, previousPages);
        if (!pages.length || ((version !== null || !info) && stale)) throw new Error($t("catalog.text_d63ac6066a"));
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

  async function findInDetails(catalog: Catalog, query: string, game: Game | undefined, roleOnly: boolean, limit: number) {
    const key = compareKey(query);
    if ([...key].length < 3 || !/\p{L}/u.test(key)) return [];
    const candidates = catalog.pages.flatMap(page => {
      if ((game && page.game !== game) || (roleOnly && page.kind !== "character") ||
          !(page.kind in detailOrder) || (page.kind === "challenge" && page.challengeMode?.id !== "leyline")) return [];
      const kind = page.kind as DetailKind;
      const pageId = kind === "challenge" ? "leyline" : pageFor(page.game, kind)?.id;
      return pageId ? page.entries.map(entry => ({ kind, entry, pageId, score: 0 })) : [];
    }).sort((left, right) => detailOrder[left.kind] - detailOrder[right.kind] ||
      left.entry.name.localeCompare(right.entry.name, "zh-Hans-CN"));
    const matches: typeof candidates = [];
    for (let offset = 0; offset < candidates.length && matches.length <= limit; offset += 12) {
      const batch = await Promise.all(candidates.slice(offset, offset + 12).map(async (candidate) => {
        const item = await readItem(candidate.entry, candidate.pageId);
        if (item && (detailMatches(item.content.detail, key) || detailMatches(item.content.list, key))) return candidate;
      }));
      for (const match of batch) if (match) matches.push(match);
    }
    return matches.slice(0, limit + 1);
  }

  async function monsterDetails(entry: AtlasEntry): Promise<MonsterDetails | undefined> {
    const item = await readItem(entry, "monster");
    const detail = object(item?.content.detail);
    if (!item || label(detail.name) !== entry.name) return;
    const description = effectText(detail.desc) || effectText(detail.description);
    if (!description) return;
    const { sections } = referenceContent(object(item.content.list), detail, object(item.meta.materialNames));
    const additional = sections.filter(({ content }) => content !== description);
    return { game: entry.game, name: entry.name, version: entry.version, description,
      artwork: galleryArtwork(item.meta.images, entry.game)(), ...(additional.length ? { sections: additional } : {}) };
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
      return entryRoots.get(starRailProSources.get(entry)?.base ?? entry) ?? (publishedRoot ? snapshot?.root : undefined) ?? configuredRoot;
    },
    locale,
    findInDetails,
    async findUnindexedLegacy(catalog: Catalog, query: string, game?: Game): Promise<Catalog | undefined> {
      const active = snapshot;
      if (!active || active.pages !== catalog.pages || active.version !== null || active.rebuilt || active.stale || !compareKey(query)) return;
      const map = await rebuildLegacyAtlasIndex(active.root, locale, { query, game }).catch(() => undefined);
      if (!map) return;
      const result = await materializePages(map, active.root);
      if (result.pages.length) return result;
    },
    async referenceDetails(entry: AtlasEntry, result: Catalog): Promise<ReferenceDetails | undefined> {
      const page = result.pages.find(({ kind, entries }) => kind === "reference" && entries.includes(entry));
      if (!page?.referenceId) return;
      const item = await readItem(entry, page.referenceId);
      if (!item) return;
      const { list, detail } = item.content;
      return { game: entry.game, name: entry.name, version: entry.version, category: page.name,
        artwork: galleryArtwork(item.meta.images, entry.game)(),
        ...referenceContent(object(list), object(detail), object(item.meta.materialNames)) };
    },
    async statusSource() {
      const root = snapshot?.root ?? await locate().then(({ root }) => root, () => configuredRoot);
      const bases = basename(root) === "data" ? [root, dirname(root)] : [root];
      const galleries = await Promise.all(bases.map(base => lstat(join(base, "gallery")).catch(() => undefined)));
      return { root, galleryReady: galleries.some(info => info?.isDirectory()) };
    },
    read(): Promise<Catalog> {
      return reading ??= (checkingShortcuts ? checkingShortcuts.then(() => read(), () => read()) : read())
        .then(withCharacterAliases).finally(() => { reading = undefined; });
    },
    readForEquipmentShortcut(): Promise<Catalog> {
      return reading ?? (checkingShortcuts ??= read(true).then(withCharacterAliases).finally(() => { checkingShortcuts = undefined; }));
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
      const pro = starRailProSources.get(character);
      const item = await readItem(pro?.base ?? character, "character");
      if (!item) return;
      const details = pro ? starRailProItem(pro.role, item.content, item.meta.images) : { content: item.content, images: item.meta.images };
      if (!details) return;
      const { rank } = object(item.content.list);
      const rarity = character.game === "zzz" ? rank === 2 ? "" : zzzRarity(rank) : character.rarity;
      return normalizeRoleDetails(character, details.content, rarity, details.images, item.meta.materialNames);
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
      return { category: planar ? $t("catalog.text_2da8a77416") : category.name, effects };
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
