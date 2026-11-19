import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyAtlasCandidate } from "./apply-candidate.ts";
import { candidateFile } from "./candidate-gallery.ts";
import { readAtlasSnapshotVersion, type AtlasPublication } from "./publish-candidate.ts";
import { discoverAtlasDataDirectory } from "./snapshot-pointer.ts";
import { acquireAtlasSource } from "./source-acquisition.ts";
import { object } from "./source-values.ts";
import { fetchAtlasManifest, planAtlasUpdate } from "./update-plan.ts";
import { validateAtlasCandidate } from "./validate-candidate.ts";

const sourcePages = { bangboo: "邦布", weapon: "音擎" } as const;
type SourcePage = keyof typeof sourcePages;
const iconFields = ["icon", "detail.icon"] as const;
type IconField = typeof iconFields[number];

export interface AtlasRefreshOptions {
  readonly pageId?: SourcePage;
  readonly signal?: AbortSignal;
  readonly manifest?: typeof fetchAtlasManifest;
  readonly request?: Parameters<typeof acquireAtlasSource>[3];
}

type AtlasSourceRefresh = AtlasPublication
  | { readonly status: "current"; readonly version: string }
  | { readonly status: "review"; readonly reason: "local-unverified" | "manifest-unavailable" | "unproven-upgrade" };

async function readJson(root: string, path: string): Promise<unknown> {
  return JSON.parse(await readFile(await candidateFile(root, path), "utf8"));
}

async function pageAssets(root: string, pageId: SourcePage, signal?: AbortSignal) {
  const map = object(await readJson(root, "map.json"));
  const game = object(object(map.games).zzz);
  const pages = object(object(object(game.locales).zh).pages);
  const records = object(object(pages[pageId]).records);
  const assets = new Map<string, { hasDetail: boolean; icons: ReadonlySet<IconField> }>();
  for (const [id, record] of Object.entries(records)) {
    signal?.throwIfAborted();
    const { path } = object(record);
    if (typeof path !== "string" || !path.startsWith("items/")) throw new Error("图鉴候选条目路径无效。");
    const { hasDetail, images } = object(object(await readJson(root, path)).meta);
    const downloaded = new Set((Array.isArray(images) ? images : []).map(object)
      .filter(({ status, placeholder }) => status === "downloaded" && placeholder !== true).map(({ fieldPath }) => fieldPath));
    assets.set(id, { hasDetail: hasDetail === true, icons: new Set(iconFields.filter((field) => downloaded.has(field))) });
  }
  return assets;
}

function regressions(pageId: SourcePage, before: Awaited<ReturnType<typeof pageAssets>>,
  after: Awaited<ReturnType<typeof pageAssets>>) {
  const issues: string[] = [];
  for (const [id, old] of before) {
    const next = after.get(id);
    if (!next) continue;
    if (old.hasDetail && !next.hasDetail) issues.push(`${sourcePages[pageId]} ${id} 缺少已有详情。`);
    for (const field of old.icons) {
      if (!next.icons.has(field)) issues.push(`${sourcePages[pageId]} ${id} 缺少已下载图标 ${field}。`);
    }
  }
  return issues;
}

/** Refresh one supported ZZZ page from the fixed source. */
export async function refreshAtlasSource(root: string, options: AtlasRefreshOptions = {}): Promise<AtlasSourceRefresh> {
  const { signal, request, manifest = fetchAtlasManifest, pageId = "bangboo" } = options;
  const scope = [{ game: "zzz", pageId }] as const;
  signal?.throwIfAborted();
  const directory = await realpath(root).catch(() => undefined);
  const baseline = directory && await discoverAtlasDataDirectory(directory).catch(() => undefined);
  if (!directory || !baseline) return { status: "review", reason: "local-unverified" };
  const local = await validateAtlasCandidate(baseline.root, scope, signal);
  if (!local.ok) return { status: "review", reason: "local-unverified" };

  const listing = await manifest(signal).catch(() => {
    signal?.throwIfAborted();
    return undefined;
  });
  signal?.throwIfAborted();
  const plan = planAtlasUpdate(listing, local, scope);
  const entry = plan.entries[0];
  if (entry?.action === "review") return { status: "review", reason: entry.reason };
  if (entry?.kind !== "versioned") return { status: "review", reason: "manifest-unavailable" };
  const active = await readAtlasSnapshotVersion(directory);
  if (active !== baseline.version) return { status: "stale", current: active };
  if (entry.action === "current") return { status: "current", version: entry.targetVersion };

  const before = await pageAssets(baseline.root, pageId, signal);
  const stage = await mkdtemp(join(dirname(directory), ".atlas-refresh-"));
  let publication: AtlasPublication | undefined;
  try {
    const source = await acquireAtlasSource(join(stage, "source"), plan.candidateRequirements, signal, request);
    const current = await readAtlasSnapshotVersion(directory);
    if (current !== baseline.version) return { status: "stale", current };
    const after = await pageAssets(join(source.directory, "data"), pageId, signal);
    const issues = regressions(pageId, before, after);
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
  const [root, selected, ...extra] = Bun.argv.slice(2);
  const pageId = selected === "zzz/bangboo" ? "bangboo" : selected === "zzz/weapon" ? "weapon" : undefined;
  if (!root || !pageId || extra.length) {
    console.error("用法：bun refresh-source.ts <图鉴根目录> <zzz/bangboo|zzz/weapon>");
    process.exitCode = 2;
  } else {
    try {
      const result = await refreshAtlasSource(root, { pageId });
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "published" && result.status !== "current") process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : `无法刷新绝区零${sourcePages[pageId]}图鉴。`);
      process.exitCode = 1;
    }
  }
}
