import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { atlasLocaleBlock, atlasPageKey, defaultAtlasLocale, type AtlasLocale } from "./locale.ts";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isMonsterGroupPage, monsterGroupKey } from "./monster-group-data.ts";
import { isStarrailRotationPage, mazeSourceOutline, starrailSourceRotation } from "./maze-source-data.ts";
import { readAchievementCategories } from "./achievements.ts";
import { applyAtlasCandidate } from "./apply-candidate.ts";
import { candidateFile } from "./candidate-gallery.ts";
import { inspectFullAtlasImages, inspectFullAtlasArtwork } from "./full-candidate-gallery.ts";
import { evidenceObject, legacyEffectiveEvidenceDigest, parseLegacyJsonEvidence } from "./legacy-json-evidence.ts";
import type { Game } from "./catalog.ts";
import { challengeModes, deadlyAssaultMode, readChallengeFacts, shiyuMode } from "./challenges.ts";
import { readAtlasSnapshotVersion, type AtlasPublicationOptions, type AtlasPublication } from "./publish-candidate.ts";
import { discoverAtlasDataDirectory } from "./snapshot-pointer.ts";
import { acquireAtlasSource } from "./source-acquisition.ts";
import { effectText, label, object } from "./source-values.ts";
import { fetchAtlasManifest, isNewerAtlasVersion, planAtlasUpdate, planPublishedChallengeRefresh, type AtlasVersionChannel } from "./update-plan.ts";
import { validateAtlasCandidate, type AtlasCandidatePage } from "./validate-candidate.ts";

const itemIcons = ["icon", "detail.icon"] as const;
const sourcePages = {
  "zzz/character": { game: "zzz", pageId: "character", title: $t("refresh-source.text_b95d7209a4"), iconFields: [] },
  "zzz/monster": { game: "zzz", pageId: "monster", title: $t("refresh-source.text_76a25acbcb"), iconFields: [] },
  "zzz/bangboo": { game: "zzz", pageId: "bangboo", title: $t("refresh-source.text_aa46a7c35b"), iconFields: itemIcons },
  "zzz/weapon": { game: "zzz", pageId: "weapon", title: $t("refresh-source.text_2ce0392ca1"), iconFields: itemIcons },
  "zzz/equipment": { game: "zzz", pageId: "equipment", title: $t("refresh-source.text_d245c1825d"), iconFields: [...itemIcons, "detail.icon2"] },
  "hsr/EliteGroup": { game: "hsr", pageId: "EliteGroup", title: $t("refresh-source.text_bdb1188d28"), iconFields: [] },
  "hsr/HardLevelGroup": { game: "hsr", pageId: "HardLevelGroup", title: $t("refresh-source.text_9438bc4cf8"), iconFields: [] },
  "hsr/InfiniteEliteGroup": { game: "hsr", pageId: "InfiniteEliteGroup", title: $t("refresh-source.text_08c6656b73"), iconFields: [] },
  "hsr/maze_extra": { game: "hsr", pageId: "maze_extra", title: $t("refresh-source.text_12407278c4"), iconFields: [] },
  "hsr/maze_boss": { game: "hsr", pageId: "maze_boss", title: $t("refresh-source.text_75bc5e1137"), iconFields: [] },
  "hsr/maze_peak": { game: "hsr", pageId: "maze_peak", title: $t("refresh-source.text_419c575f1e"), iconFields: [] },
  "hsr/maze": { game: "hsr", pageId: "maze", title: $t("refresh-source.text_59e54b366d"), iconFields: [] },
  "hsr/monster": { game: "hsr", pageId: "monster", title: $t("refresh-source.text_b221591d3f"), iconFields: ["icon", "derived.monsterFigure", "detail.image_path"] },
  "hsr/monstervalue": { game: "hsr", pageId: "monstervalue", title: $t("refresh-source.text_83ebe3015f"), iconFields: [] },
  "hsr/relicset": { game: "hsr", pageId: "relicset", title: $t("refresh-source.text_810786eac8"), iconFields: itemIcons },
  "hsr/lightcone": { game: "hsr", pageId: "lightcone", title: $t("refresh-source.text_e733238b28"),
    iconFields: ["derived.lightConeMediumIcon", "derived.path", "detail.derived.lightConeMediumIcon"] },
  "zzz/achievement/achievement": { game: "zzz", pageId: "achievement/achievement", title: $t("refresh-source.text_6d515a5b4d"), iconFields: [] },
  "gi/achievement/achievement": { game: "gi", pageId: "achievement/achievement", title: $t("refresh-source.text_5013174952"), iconFields: ["icon"] },
  "hsr/achievement/achievement": { game: "hsr", pageId: "achievement/achievement", title: $t("refresh-source.text_d6aa0908db"), iconFields: [] },
  "gi/artifact": { game: "gi", pageId: "artifact", title: $t("refresh-source.text_c53f62c9ea"), iconFields: itemIcons },
  "gi/gcg": { game: "gi", pageId: "gcg", title: $t("refresh-source.text_8c8df27f6c"), iconFields: itemIcons },
  "gi/weapon": { game: "gi", pageId: "weapon", title: $t("refresh-source.text_086cdc5c1f"), iconFields: itemIcons },
  "zzz/boss": { game: "zzz", pageId: "boss", title: $t("refresh-source.text_4b7b8e83d9"), iconFields: [] },
  "zzz/shiyu": { game: "zzz", pageId: "shiyu", title: $t("refresh-source.text_f718dc4321"), iconFields: [] },
} as const;
export type SourceSelection = keyof typeof sourcePages;
type SourcePage = { readonly game: Game; readonly locale?: AtlasLocale; readonly pageId: string; readonly title: string; readonly iconFields: readonly string[] };
type FullImageEvidence = ReturnType<typeof inspectFullAtlasImages>;
type ChallengeFacts = ReturnType<typeof readChallengeFacts>;

const otherTitles: Readonly<Partial<Record<string, string>>> = {
  "gi/character": $t("refresh-source.text_70320f908f"), "gi/monster": $t("refresh-source.text_f624c9cf15"), "hsr/character": $t("refresh-source.text_6d949d3a2f"),
};

function fullSourcePage(game: Game, pageId: string, locale?: AtlasLocale): SourcePage {
  const key = `${game}/${pageId}`;
  if (isSourceSelection(key)) return { ...sourcePages[key], locale };
  const title = otherTitles[key] ?? challengeModes.find(mode => mode.game === game && mode.id === pageId)?.name ?? key;
  return { game, pageId, title, iconFields: [], locale };
}
const defaultSelections = { bangboo: "zzz/bangboo", weapon: "zzz/weapon", lightcone: "hsr/lightcone",
  equipment: "zzz/equipment", boss: "zzz/boss", shiyu: "zzz/shiyu" } as const;

function isSourceSelection(value: unknown): value is SourceSelection {
  return typeof value === "string" && Object.hasOwn(sourcePages, value);
}

export interface AtlasRefreshOptions {
  readonly channel?: AtlasVersionChannel;
  readonly pageId?: keyof typeof defaultSelections;
  readonly selection?: SourceSelection;
  readonly signal?: AbortSignal;
  readonly manifest?: typeof fetchAtlasManifest;
  readonly request?: Parameters<typeof acquireAtlasSource>[3];
  readonly preserveRecords?: boolean;
  readonly expected?: Awaited<ReturnType<typeof discoverAtlasDataDirectory>>;
  readonly publication?: AtlasPublicationOptions;
}

export type AtlasSourceRefresh = AtlasPublication
  | { readonly status: "current"; readonly version: string }
  | { readonly status: "review"; readonly reason: "local-unverified" | "manifest-unavailable" | "unproven-upgrade" };

async function readJson(root: string, path: string): Promise<unknown> {
  return JSON.parse(await readFile(await candidateFile(root, path), "utf8"));
}

async function pageAssets(root: string, { game, pageId, iconFields, locale = defaultAtlasLocale }: SourcePage, signal?: AbortSignal, fullImages?: FullImageEvidence) {
  const mode = fullImages ? challengeModes.find(mode => mode.game === game && mode.id === pageId) : pageId === "boss" ? deadlyAssaultMode : pageId === "shiyu" ? shiyuMode : isStarrailRotationPage(pageId) ? starrailSourceRotation(pageId).mode : undefined;
  const map = object(await readJson(root, "map.json"));
  const gameData = object(object(map.games)[game]);
  const pages = object(atlasLocaleBlock(gameData, locale).pages);
  const records = object(object(pages[pageId]).records);
  const assets = new Map<string, { name: unknown; hasDetail: boolean; icons: ReadonlySet<string>;
    window?: ChallengeFacts["window"]; challenge?: ChallengeFacts["sections"]; effective?: string;
    imageDigests?: ReadonlyMap<string, string>; parts?: string[]; effects?: string[]; variants?: unknown[]; phases?: unknown[]; groupFields?: string[]; description?: string; maze?: ReturnType<typeof mazeSourceOutline> }>();
  const achievementSources: { id: string; name: string; list: unknown }[] = [];
  for (const [id, record] of Object.entries(records)) {
    signal?.throwIfAborted();
    const { path, rarity: indexRarity } = object(record);
    if (typeof path !== "string" || !path.startsWith("items/")) throw new Error($t("refresh-source.text_56c99bcc38"));
    const raw = await readFile(await candidateFile(root, path), "utf8");
    const item = object(JSON.parse(raw));
    const { hasDetail, images, name } = object(item.meta);
    const downloaded = new Set((Array.isArray(images) ? images : []).map(object)
      .flatMap(({ status, placeholder, fieldPath }) =>
        status === "downloaded" && placeholder !== true && typeof fieldPath === "string" &&
          !fieldPath.startsWith("derived.material.") ? [fieldPath] : []));
    if (pageId === "achievement/achievement") {
      achievementSources.push({ id, name: typeof name === "string" ? name : "", list: object(item.content).list });
    }
    const facts = mode ? readChallengeFacts(mode, object(item.content)) : undefined;
    const window = facts?.window;
    const content = object(item.content);
    const detail = object(content.detail);
    const values = object(content.list);
    const zenlessMonster = game === "zzz" && pageId === "monster";
    const variantIds = zenlessMonster ? Object.keys(object(detail.monster_info)) : Array.isArray(values.child)
      ? pageId === "monstervalue" ? values.child.map(variant => object(variant).Id)
        : pageId === "monster" ? values.child : undefined
      : undefined;
    const phaseList = pageId === "monstervalue" ? values.PhaseList : pageId === "monster" ? detail.phase_list : undefined;
    const phases = Array.isArray(phaseList) ? phaseList.map(phase => object(phase).phase_num) : undefined;
    const description = pageId === "monster" ? effectText(detail.desc) : undefined;
    const setParts = pageId === "relicset" || pageId === "artifact" ? Object.keys(object(detail.parts)) : undefined;
    const effects = pageId === "relicset" ? Object.keys(object(detail.require_num))
      : pageId === "artifact" && Array.isArray(detail.need) ? detail.need.map(String) : undefined;
    let key = id;
    let groupFields: string[] | undefined;
    if (isMonsterGroupPage(pageId)) {
      const semanticKey = monsterGroupKey(pageId, values);
      if (!semanticKey || assets.has(semanticKey)) throw new Error($t("refresh-source.text_f0954a1a80", { "game": game, "pageId": pageId }));
      key = semanticKey;
      groupFields = Object.keys(values);
    }
    const maze = isStarrailRotationPage(pageId) ? mazeSourceOutline(pageId, content.detail, typeof name === "string" ? name : "", id) : undefined;
    if (!fullImages && isStarrailRotationPage(pageId) && !maze) throw new Error($t("refresh-source.text_df2e3f3756", { "name": starrailSourceRotation(pageId).mode.name, "id": id }));
    const imageDigests = fullImages && await fullImages.read(game, pageId, key, images);
    let effective: string | undefined;
    if (fullImages) {
      const evidence = evidenceObject(parseLegacyJsonEvidence(raw));
      const metadata = evidenceObject(evidence.meta ?? null);
      effective = legacyEffectiveEvidenceDigest({
        name: isMonsterGroupPage(pageId) ? null : metadata.name ?? null, indexRarity: label(indexRarity),
        rarity: metadata.rarity ?? null, materialNames: metadata.materialNames ?? null,
        hasDetail: metadata.hasDetail ?? null, content: evidence.content ?? null,
      });
    }
    assets.set(key, { name, window, maze, hasDetail: hasDetail === true && (!fullImages || usableDetail(content.detail)),
      parts: setParts, effects, variants: variantIds, phases, groupFields, description, effective, imageDigests,
      challenge: fullImages ? facts?.sections : undefined,
      icons: imageDigests ? new Set(imageDigests.keys()) : mode || pageId === "artifact" || pageId === "character" || zenlessMonster
        ? downloaded : new Set(iconFields.filter((field) => downloaded.has(field))) });
  }
  const achievements = pageId === "achievement/achievement" ? readAchievementCategories(game, {
    version: "", sourceUrl: "", sources: achievementSources,
  }) : [];
  const achievementIds = new Set(achievements.flatMap(({ entries }) => entries.map(({ id }) => id)));
  const achievementGroups = new Set<string>();
  if (game === "zzz" && pageId === "achievement/achievement") {
    for (const { id } of achievements) achievementGroups.add($t("refresh-source.text_2f2a653b45", { "id": id }));
    for (const { id, list } of achievementSources) {
      if (id === "category" || id === "mutual_type") {
        const title = id === "category" ? $t("refresh-source.text_07c167eb4e") : $t("refresh-source.text_29c00d44de");
        for (const key of Object.keys(object(list))) achievementGroups.add(`${title} ${key}`);
      }
    }
  }
  return { assets, achievementIds, achievementGroups };
}

function usableDetail(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(usableDetail);
  if (value !== null && typeof value === "object") return Object.values(object(value)).some(usableDetail);
  return value !== null && value !== undefined && (typeof value !== "string" || value.trim() !== "");
}

function regressions({ game, title, pageId }: SourcePage, before: Awaited<ReturnType<typeof pageAssets>>,
  after: Awaited<ReturnType<typeof pageAssets>>, preserveRecords: boolean, full = false) {
  const preserveRotation = pageId === "boss" || pageId === "shiyu" || isStarrailRotationPage(pageId) ||
    (full && challengeModes.some(mode => mode.game === game && mode.id === pageId));
  const issues: string[] = [];
  for (const id of before.achievementIds) {
    if (!after.achievementIds.has(id)) issues.push($t("refresh-source.text_e6b18efff5", { "title": title, "id": id }));
  }
  for (const group of before.achievementGroups) {
    if (!after.achievementGroups.has(group)) issues.push($t("refresh-source.text_01f0de000f", { "title": title, "group": group }));
  }
  for (const [id, old] of before.assets) {
    const next = after.assets.get(id);
    if (!next) {
      if (preserveRotation) issues.push($t("refresh-source.text_37895076cd", { "title": title, "id": id }));
      if (pageId === "equipment") issues.push($t("refresh-source.text_0d76eccf57", { "title": title, "id": id }));
      if (game === "zzz" && pageId === "weapon") issues.push($t("refresh-source.text_893935edeb", { "title": title, "id": id }));
      if ((preserveRecords || pageId === "gcg" || pageId === "character" || pageId === "achievement/achievement" || pageId === "relicset" || pageId === "artifact" || pageId === "monstervalue" || pageId === "monster" || isMonsterGroupPage(pageId)) && !preserveRotation && pageId !== "equipment" && !(game === "zzz" && pageId === "weapon")) {
        issues.push($t("refresh-source.text_0765183046", { "title": title, "id": id }));
      }
      continue;
    }
    const unnamedPreview = pageId === "maze_boss" && id === "3024" && old.name === id && old.window?.from !== "live";
    // The archived index used the version as a provisional name for period 8.
    const arbitrationPreview = pageId === "maze_peak" && id === "8" && effectText(old.name) === "4.4异相仲裁" &&
      effectText(next.name) === "尘世卷中" && old.window?.from !== "live";
    if (preserveRotation && ((!unnamedPreview && !arbitrationPreview && effectText(old.name) !== effectText(next.name)) || (old.window?.from === "live" &&
      (next.window?.from !== "live" || old.window.begin !== next.window.begin || old.window.end !== next.window.end)))) {
      issues.push($t("refresh-source.text_bebbbb6612", { "title": title, "id": id }));
    }
    if (pageId === "character" && old.name !== next.name) issues.push($t("refresh-source.text_236344c763", { "title": title, "id": id }));
    if (pageId === "gcg" && old.name !== next.name) issues.push($t("refresh-source.text_8bda1b07d2", { "title": title, "id": id }));
    if (game === "zzz" && pageId === "monster" && old.name !== "OfficialName_" && old.name !== next.name) {
      issues.push($t("refresh-source.text_9c1f058c33", { "title": title, "id": id }));
    }
    if (old.parts?.some(part => !next.parts?.includes(part)) || old.effects?.some(effect => !next.effects?.includes(effect))) {
      issues.push($t("refresh-source.text_ea5a565f3e", { "title": title, "id": id }));
    }
    if (old.variants?.some(id => !next.variants?.includes(id)) || old.phases?.some(phase => !next.phases?.includes(phase))) {
      issues.push($t("refresh-source.text_40c4c6654e", { "title": title, "id": id }));
    }
    if (old.groupFields?.some(field => !next.groupFields?.includes(field))) {
      issues.push($t("refresh-source.text_f1691435e9", { "title": title, "id": id }));
    }
    if (old.description && !next.description) issues.push($t("refresh-source.text_56525bbe19", { "title": title, "id": id }));
    const oldMaze = old.maze;
    if (oldMaze && (["floors", "stages", "enemies"] as const).some(key =>
      [...oldMaze[key]].some(value => !next.maze?.[key].has(value)))) {
      issues.push($t("refresh-source.text_98c049debf", { "title": title, "id": id }));
    }
    if (old.challenge?.some(section => {
      const matches = next.challenge?.filter(current => current.label === section.label) ?? [];
      return !matches.some(current => current.count >= section.count &&
        (pageId !== "tower" || section.items.every(item => current.items.includes(item))));
    })) issues.push($t("refresh-source.text_40ae023db8", { "title": title, "id": id }));
    if (old.hasDetail && !next.hasDetail) issues.push($t("refresh-source.text_3270ac31ec", { "title": title, "id": id }));
    for (const field of old.icons) {
      if (!next.icons.has(field)) issues.push($t("refresh-source.text_11ef5964fe", { "title": title, "id": id, "field": field }));
    }
  }
  return issues;
}

function sameImages(before: ReadonlyMap<string, string> | undefined, after: ReadonlyMap<string, string> | undefined) {
  if (!before || !after) return before === after;
  // The first valid image also serves as the record's generic illustration.
  if (before.size !== after.size || before.values().next().value !== after.values().next().value) return false;
  return [...before].every(([field, digest]) => after.get(field) === digest);
}

/** Compare materialized snapshots, after filling any source delta into the candidate. */
export async function inspectFullAtlasCandidate(baselineData: string, candidateData: string,
  scope: readonly AtlasCandidatePage[], signal?: AbortSignal,
): Promise<{ readonly issues: readonly string[]; readonly unchanged: boolean }> {
  if (!scope.length || new Set(scope.map(atlasPageKey)).size !== scope.length) {
    throw new Error($t("refresh-source.text_ca8260cf5b"));
  }
  const [beforeRoot, afterRoot] = await Promise.all([realpath(baselineData), realpath(candidateData)]);
  const [before, after] = await Promise.all([
    validateAtlasCandidate(beforeRoot, [], signal), validateAtlasCandidate(afterRoot, scope, signal),
  ]);
  if (!before.ok || !after.ok) return { unchanged: false, issues: [...before.issues, ...after.issues] };

  const issues: string[] = [];
  const beforePages = new Map(before.pages.map(page => [atlasPageKey(page), page]));
  const afterPages = new Map(after.pages.map(page => [atlasPageKey(page), page]));
  const beforeImages = inspectFullAtlasImages(beforeRoot, signal);
  const afterImages = inspectFullAtlasImages(afterRoot, signal, issues);
  let unchanged = beforePages.size === afterPages.size;
  for (const [key, previous] of beforePages) {
    const next = afterPages.get(key);
    if (!next) {
      issues.push($t("refresh-source.text_2189796d5c", { "key": key }));
      continue;
    }
    if (previous.version !== next.version && !isNewerAtlasVersion(next.version, previous.version, previous.game)) {
      issues.push($t("refresh-source.text_d314decadd", { "key": key, "version": next.version, "value3": previous.version }));
    }
  }
  for (const [key, next] of afterPages) {
    const previous = beforePages.get(key);
    const page = fullSourcePage(next.game, next.pageId, next.locale);
    const [old, current] = await Promise.all([
      previous ? pageAssets(beforeRoot, page, signal, beforeImages) : undefined,
      pageAssets(afterRoot, page, signal, afterImages),
    ]);
    if (old) issues.push(...regressions(page, old, current, true, true));
    if (!old || previous?.version !== next.version || old.assets.size !== current.assets.size) unchanged = false;
    if (unchanged && old) {
      for (const [id, item] of old.assets) {
        const updated = current.assets.get(id);
        if (!updated || item.effective !== updated.effective || !sameImages(item.imageDigests, updated.imageDigests)) {
          unchanged = false;
          break;
        }
      }
    }
  }
  if (await inspectFullAtlasArtwork(beforeRoot, afterRoot, issues, signal)) unchanged = false;
  return { issues, unchanged: unchanged && issues.length === 0 };
}

export function atlasSourcePlan(selection: SourceSelection, listing: unknown,
  local: Awaited<ReturnType<typeof validateAtlasCandidate>>, channel?: AtlasVersionChannel) {
  const { game, pageId } = sourcePages[selection];
  if (selection !== "gi/gcg" && !local.pages.some((page) => page.game === game && page.pageId === pageId && !page.locale)) {
    local = { ...local, ok: false };
  }
  if (isStarrailRotationPage(pageId)) return planPublishedChallengeRefresh(listing, local, { game: "hsr", pageId }, channel);
  return pageId === "boss" || pageId === "shiyu" ? planPublishedChallengeRefresh(listing, local, { game: "zzz", pageId }, channel)
    : planAtlasUpdate(listing, local, [{ game, pageId }], channel);
}

export const atlasSourceSelections = Object.entries(sourcePages).map(([selection, { title }]) =>
  ({ selection: selection as SourceSelection, title }));

/** Refresh one supported page from the fixed source. */
export async function refreshAtlasSource(root: string, options: AtlasRefreshOptions = {}): Promise<AtlasSourceRefresh> {
  const { signal, request, manifest = fetchAtlasManifest, pageId = "bangboo", selection = defaultSelections[pageId] } = options;
  if (!isSourceSelection(selection)) throw new TypeError($t("refresh-source.text_44af67af8d"));
  const page = sourcePages[selection];
  const scope = [{ game: page.game, pageId: page.pageId }] as const;
  signal?.throwIfAborted();
  const directory = await realpath(root).catch(() => undefined);
  const baseline = options.publication?.preparation?.baseline ?? (directory && await discoverAtlasDataDirectory(directory).catch(() => undefined));
  if (!directory || !baseline) return { status: "review", reason: "local-unverified" };
  if (options.expected && (options.expected.version !== baseline.version || options.expected.root !== baseline.root)) {
    return { status: "stale", current: baseline.version };
  }
  const local = await validateAtlasCandidate(baseline.root, selection === "gi/gcg" ? [] : scope, signal);
  if (!local.ok) return { status: "review", reason: "local-unverified" };

  const listing = await manifest(signal).catch(() => {
    signal?.throwIfAborted();
    return undefined;
  });
  signal?.throwIfAborted();
  const plan = atlasSourcePlan(selection, listing, local, options.channel);
  const entry = plan.entries[0];
  if (entry?.action === "review") return { status: "review", reason: entry.reason };
  if (entry?.kind !== "versioned") return { status: "review", reason: "manifest-unavailable" };
  const active = await readAtlasSnapshotVersion(directory);
  if (active !== baseline.version) return { status: "stale", current: active };
  if (entry.action === "current") return { status: "current", version: entry.targetVersion };

  const before = await pageAssets(baseline.root, page, signal);
  const stage = await mkdtemp(join(dirname(directory), ".atlas-refresh-"));
  let publication: AtlasPublication | undefined;
  try {
    const source = await acquireAtlasSource(join(stage, "source"), plan.candidateRequirements, signal, request);
    const current = await readAtlasSnapshotVersion(directory);
    if (current !== baseline.version) return { status: "stale", current };
    const after = await pageAssets(join(source.directory, "data"), page, signal);
    const issues = regressions(page, before, after, options.preserveRecords === true);
    if (selection === "hsr/monster" && local.pages.some(({ game, pageId, version, locale }) =>
      !locale && game === "hsr" && pageId === "monstervalue" && version === entry.targetVersion)) {
      const values = await pageAssets(baseline.root, sourcePages["hsr/monstervalue"], signal);
      for (const [id, record] of values.assets) {
        const monster = after.assets.get(id);
        if (!monster || record.variants?.some(variant => !monster.variants?.includes(variant))) {
          issues.push($t("refresh-source.text_d6118bcbe4", { "id": id }));
        }
      }
    }
    if (isStarrailRotationPage(page.pageId)) {
      const links = [
        { selections: ["hsr/monstervalue"], field: "battleEnemies" },
        { selections: ["hsr/EliteGroup"], field: "eliteGroups" },
        { selections: ["hsr/HardLevelGroup"], field: "difficultyGroups" },
        { selections: ["hsr/EliteGroup", "hsr/InfiniteEliteGroup"], field: "waveEliteGroups" },
      ] as const;
      const knownByPage = new Map<SourceSelection, Set<string>>();
      for (const { selections, field } of links) {
        if (field === "waveEliteGroups" && page.pageId !== "maze_peak") continue;
        if (!selections.every((selection) => local.pages.some(({ game, pageId, version, locale }) =>
          !locale && game === "hsr" && pageId === sourcePages[selection].pageId && version === entry.targetVersion))) continue;
        const permitted: Set<string>[] = [];
        for (const selection of selections) {
          let known = knownByPage.get(selection);
          if (!known) {
            const linked = await pageAssets(baseline.root, sourcePages[selection], signal);
            known = new Set([...linked.assets].flatMap(([id, record]) => [id, ...(record.variants ?? []).map(String)]));
            knownByPage.set(selection, known);
          }
          permitted.push(known);
        }
        const linkedTitle = selections.map(selection => sourcePages[selection].title).join($t("refresh-source.text_a2123d6950"));
        for (const [id, record] of after.assets) {
          const missing = [...record.maze?.[field] ?? []].find(key => !permitted.some(known => known.has(key)));
          if (missing) issues.push($t("refresh-source.text_6a5c195f0f", { "name": starrailSourceRotation(page.pageId).mode.name, "id": id, "linkedTitle": linkedTitle, "missing": missing }));
        }
      }
    }
    if (issues.length) return { status: "invalid", issues };
    publication = await applyAtlasCandidate(directory, source.directory, plan.candidateRequirements, signal, baseline, options.publication);
    return publication;
  } finally {
    const cleanup = rm(stage, { recursive: true, force: true });
    // Once committed, a staging cleanup failure cannot change the publication result.
    if (publication?.status === "published" || publication?.status === "prepared") await cleanup.catch(() => {});
    else await cleanup;
  }
}

if (import.meta.main) {
  const [root, selection, ...extra] = Bun.argv.slice(2);
  if (!root || !isSourceSelection(selection) || extra.length) {
    console.error($t("refresh-source.text_e78fa5f026", { "value1": Object.keys(sourcePages).join("|") }));
    process.exitCode = 2;
  } else {
    try {
      const result = await refreshAtlasSource(root, { selection });
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "published" && result.status !== "current") process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : $t("refresh-source.text_608b7e8d9a", { "title": sourcePages[selection].title }));
      process.exitCode = 1;
    }
  }
}
