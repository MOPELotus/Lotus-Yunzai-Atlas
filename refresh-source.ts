import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readAchievementCategories } from "./achievements.ts";
import { applyAtlasCandidate } from "./apply-candidate.ts";
import { candidateFile } from "./candidate-gallery.ts";
import { deadlyAssaultMode, readChallengeFacts, shiyuMode } from "./challenges.ts";
import { readAtlasSnapshotVersion, type AtlasPublication } from "./publish-candidate.ts";
import { discoverAtlasDataDirectory } from "./snapshot-pointer.ts";
import { acquireAtlasSource } from "./source-acquisition.ts";
import { object } from "./source-values.ts";
import { fetchAtlasManifest, planAtlasUpdate, planPublishedZzzRefresh } from "./update-plan.ts";
import { validateAtlasCandidate } from "./validate-candidate.ts";

const itemIcons = ["icon", "detail.icon"] as const;
const sourcePages = {
  "zzz/bangboo": { game: "zzz", pageId: "bangboo", title: "邦布", iconFields: itemIcons },
  "zzz/weapon": { game: "zzz", pageId: "weapon", title: "音擎", iconFields: itemIcons },
  "zzz/equipment": { game: "zzz", pageId: "equipment", title: "驱动盘", iconFields: [...itemIcons, "detail.icon2"] },
  "hsr/relicset": { game: "hsr", pageId: "relicset", title: "星铁遗器", iconFields: itemIcons },
  "hsr/lightcone": { game: "hsr", pageId: "lightcone", title: "光锥",
    iconFields: ["derived.lightConeMediumIcon", "derived.path", "detail.derived.lightConeMediumIcon"] },
  "zzz/achievement/achievement": { game: "zzz", pageId: "achievement/achievement", title: "绝区零成就", iconFields: [] },
  "gi/achievement/achievement": { game: "gi", pageId: "achievement/achievement", title: "原神成就", iconFields: ["icon"] },
  "hsr/achievement/achievement": { game: "hsr", pageId: "achievement/achievement", title: "星铁成就", iconFields: [] },
  "gi/weapon": { game: "gi", pageId: "weapon", title: "原神武器", iconFields: itemIcons },
  "zzz/boss": { game: "zzz", pageId: "boss", title: "危局强袭战", iconFields: [] },
  "zzz/shiyu": { game: "zzz", pageId: "shiyu", title: "式舆防卫战", iconFields: [] },
} as const;
export type SourceSelection = keyof typeof sourcePages;
type SourcePage = typeof sourcePages[SourceSelection];
const defaultSelections = { bangboo: "zzz/bangboo", weapon: "zzz/weapon", lightcone: "hsr/lightcone",
  equipment: "zzz/equipment", boss: "zzz/boss", shiyu: "zzz/shiyu" } as const;

function isSourceSelection(value: unknown): value is SourceSelection {
  return typeof value === "string" && Object.hasOwn(sourcePages, value);
}

export interface AtlasRefreshOptions {
  readonly pageId?: keyof typeof defaultSelections;
  readonly selection?: SourceSelection;
  readonly signal?: AbortSignal;
  readonly manifest?: typeof fetchAtlasManifest;
  readonly request?: Parameters<typeof acquireAtlasSource>[3];
  readonly preserveRecords?: boolean;
  readonly expected?: Awaited<ReturnType<typeof discoverAtlasDataDirectory>>;
}

export type AtlasSourceRefresh = AtlasPublication
  | { readonly status: "current"; readonly version: string }
  | { readonly status: "review"; readonly reason: "local-unverified" | "manifest-unavailable" | "unproven-upgrade" };

async function readJson(root: string, path: string): Promise<unknown> {
  return JSON.parse(await readFile(await candidateFile(root, path), "utf8"));
}

async function pageAssets(root: string, { game, pageId, iconFields }: SourcePage, signal?: AbortSignal) {
  const mode = pageId === "boss" ? deadlyAssaultMode : pageId === "shiyu" ? shiyuMode : undefined;
  const map = object(await readJson(root, "map.json"));
  const gameData = object(object(map.games)[game]);
  const pages = object(object(object(gameData.locales).zh).pages);
  const records = object(object(pages[pageId]).records);
  const assets = new Map<string, { name: unknown; hasDetail: boolean; icons: ReadonlySet<string>;
    window?: ReturnType<typeof readChallengeFacts>["window"]; parts?: string[]; effects?: string[] }>();
  const achievementSources: { id: string; name: string; list: unknown }[] = [];
  for (const [id, record] of Object.entries(records)) {
    signal?.throwIfAborted();
    const { path } = object(record);
    if (typeof path !== "string" || !path.startsWith("items/")) throw new Error("图鉴候选条目路径无效。");
    const item = object(await readJson(root, path));
    const { hasDetail, images, name } = object(item.meta);
    const downloaded = new Set((Array.isArray(images) ? images : []).map(object)
      .flatMap(({ status, placeholder, fieldPath }) =>
        status === "downloaded" && placeholder !== true && typeof fieldPath === "string" ? [fieldPath] : []));
    if (pageId === "achievement/achievement") {
      achievementSources.push({ id, name: typeof name === "string" ? name : "", list: object(item.content).list });
    }
    const window = mode ? readChallengeFacts(mode, object(item.content)).window : undefined;
    const detail = object(object(item.content).detail);
    const relicset = pageId === "relicset" ? {
      parts: Object.keys(object(detail.parts)), effects: Object.keys(object(detail.require_num)),
    } : undefined;
    assets.set(id, { name, window, hasDetail: hasDetail === true, ...relicset,
      icons: mode ? downloaded : new Set(iconFields.filter((field) => downloaded.has(field))) });
  }
  const achievements = pageId === "achievement/achievement" ? readAchievementCategories(game, {
    version: "", sourceUrl: "", sources: achievementSources,
  }) : [];
  const achievementIds = new Set(achievements.flatMap(({ entries }) => entries.map(({ id }) => id)));
  const achievementGroups = new Set<string>();
  if (game === "zzz" && pageId === "achievement/achievement") {
    for (const { id } of achievements) achievementGroups.add(`子分类 ${id}`);
    for (const { id, list } of achievementSources) {
      if (id === "category" || id === "mutual_type") {
        const title = id === "category" ? "一级分类" : "互斥数据";
        for (const key of Object.keys(object(list))) achievementGroups.add(`${title} ${key}`);
      }
    }
  }
  return { assets, achievementIds, achievementGroups };
}

function regressions({ game, title, pageId }: SourcePage, before: Awaited<ReturnType<typeof pageAssets>>,
  after: Awaited<ReturnType<typeof pageAssets>>, preserveRecords: boolean) {
  const preserveRotation = pageId === "boss" || pageId === "shiyu";
  const issues: string[] = [];
  for (const id of before.achievementIds) {
    if (!after.achievementIds.has(id)) issues.push(`${title}缺少已有条目 ${id}。`);
  }
  for (const group of before.achievementGroups) {
    if (!after.achievementGroups.has(group)) issues.push(`${title}缺少已有${group}。`);
  }
  for (const [id, old] of before.assets) {
    const next = after.assets.get(id);
    if (!next) {
      if (preserveRotation) issues.push(`${title} ${id} 缺少已有轮换资料。`);
      if (pageId === "equipment") issues.push(`${title} ${id} 缺少已有套装资料。`);
      if (game === "zzz" && pageId === "weapon") issues.push(`${title} ${id} 缺少已有音擎资料。`);
      if ((preserveRecords || pageId === "achievement/achievement" || pageId === "relicset") && !preserveRotation && pageId !== "equipment" && !(game === "zzz" && pageId === "weapon")) {
        issues.push(`${title} ${id} 缺少已有条目。`);
      }
      continue;
    }
    if (preserveRotation && (old.name !== next.name || (old.window?.from === "live" &&
      (next.window?.from !== "live" || old.window.begin !== next.window.begin || old.window.end !== next.window.end)))) {
      issues.push(`${title} ${id} 与已有身份或实装窗口冲突。`);
    }
    if (old.parts?.some(part => !next.parts?.includes(part)) || old.effects?.some(effect => !next.effects?.includes(effect))) {
      issues.push(`${title} ${id} 缺少已有部位或套装效果。`);
    }
    if (old.hasDetail && !next.hasDetail) issues.push(`${title} ${id} 缺少已有详情。`);
    for (const field of old.icons) {
      if (!next.icons.has(field)) issues.push(`${title} ${id} 缺少已下载图标 ${field}。`);
    }
  }
  return issues;
}

export function atlasSourcePlan(selection: SourceSelection, listing: unknown,
  local: Awaited<ReturnType<typeof validateAtlasCandidate>>) {
  const { game, pageId } = sourcePages[selection];
  if (!local.pages.some((page) => page.game === game && page.pageId === pageId)) local = { ...local, ok: false };
  return pageId === "boss" || pageId === "shiyu" ? planPublishedZzzRefresh(listing, local, pageId)
    : planAtlasUpdate(listing, local, [{ game, pageId }]);
}

export const atlasSourceSelections = Object.entries(sourcePages).map(([selection, { title }]) =>
  ({ selection: selection as SourceSelection, title }));

/** Refresh one supported page from the fixed source. */
export async function refreshAtlasSource(root: string, options: AtlasRefreshOptions = {}): Promise<AtlasSourceRefresh> {
  const { signal, request, manifest = fetchAtlasManifest, pageId = "bangboo", selection = defaultSelections[pageId] } = options;
  if (!isSourceSelection(selection)) throw new TypeError("请选择支持刷新的图鉴分类。");
  const page = sourcePages[selection];
  const scope = [{ game: page.game, pageId: page.pageId }] as const;
  signal?.throwIfAborted();
  const directory = await realpath(root).catch(() => undefined);
  const baseline = directory && await discoverAtlasDataDirectory(directory).catch(() => undefined);
  if (!directory || !baseline) return { status: "review", reason: "local-unverified" };
  if (options.expected && (options.expected.version !== baseline.version || options.expected.root !== baseline.root)) {
    return { status: "stale", current: baseline.version };
  }
  const local = await validateAtlasCandidate(baseline.root, scope, signal);
  if (!local.ok) return { status: "review", reason: "local-unverified" };

  const listing = await manifest(signal).catch(() => {
    signal?.throwIfAborted();
    return undefined;
  });
  signal?.throwIfAborted();
  const plan = atlasSourcePlan(selection, listing, local);
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
    if (issues.length) return { status: "invalid", issues };
    publication = await applyAtlasCandidate(directory, source.directory, plan.candidateRequirements, signal, baseline);
    return publication;
  } finally {
    const cleanup = rm(stage, { recursive: true, force: true });
    // Once committed, a staging cleanup failure cannot change the publication result.
    if (publication?.status === "published") await cleanup.catch(() => {});
    else await cleanup;
  }
}

if (import.meta.main) {
  const [root, selection, ...extra] = Bun.argv.slice(2);
  if (!root || !isSourceSelection(selection) || extra.length) {
    console.error(`用法：bun refresh-source.ts <图鉴根目录> <${Object.keys(sourcePages).join("|")}>`);
    process.exitCode = 2;
  } else {
    try {
      const result = await refreshAtlasSource(root, { selection });
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "published" && result.status !== "current") process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : `无法刷新${sourcePages[selection].title}图鉴。`);
      process.exitCode = 1;
    }
  }
}
