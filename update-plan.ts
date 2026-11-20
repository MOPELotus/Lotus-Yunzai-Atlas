import type { Game } from "./catalog.ts";
import { atlasSourceOrigin, readAtlasSourceBytes } from "./source-transport.ts";
import type { StarrailRotationPage } from "./maze-source-data.ts";
import { isMonsterGroupPage } from "./monster-group-data.ts";
import { object } from "./source-values.ts";
import { validateAtlasCandidate, type AtlasCandidatePage, type AtlasCandidateValidation } from "./validate-candidate.ts";

export const atlasManifestUrl = `${atlasSourceOrigin}/manifest.json`;

const maxManifestBytes = 1024 * 1024;
const versions = /^(0|[1-9]\d{0,7})(?:\.(?:0|[1-9]\d{0,7})){1,3}(?:\+(?:0|[1-9]\d{0,14}))?$/u;

const pageIds = {
  gi: { versioned: ["character", "weapon", "artifact", "achievement/achievement", "monster"],
    challenge: ["tower", "rolecombat", "leyline"] },
  hsr: { versioned: ["character", "lightcone", "relicset", "achievement/achievement", "monster", "monstervalue", "EliteGroup", "HardLevelGroup", "InfiniteEliteGroup"],
    challenge: ["maze", "maze_boss", "maze_extra", "maze_peak"] },
  zzz: { versioned: ["character", "weapon", "equipment", "bangboo", "achievement/achievement", "monster"],
    challenge: ["boss", "shiyu"] },
} as const;

export type AtlasPlanPage = Readonly<Pick<AtlasCandidatePage, "game" | "pageId">>;

type AtlasPlanEntry = AtlasPlanPage & { readonly localVersion?: string } & (
  { readonly kind: "versioned"; readonly action: "current" | "fetch"; readonly targetVersion: string } |
  { readonly kind: "versioned"; readonly action: "review"; readonly reason: "manifest-unavailable" | "local-unverified" } |
  { readonly kind: "versioned"; readonly action: "review"; readonly reason: "unproven-upgrade"; readonly targetVersion: string } |
  { readonly kind: "challenge"; readonly action: "audit-rotation" }
);

export interface AtlasUpdatePlan {
  readonly entries: readonly AtlasPlanEntry[];
  readonly candidateRequirements: readonly AtlasCandidatePage[];
}

const trackedPages = (Object.keys(pageIds) as Game[]).flatMap((game) =>
  (["versioned", "challenge"] as const).flatMap((kind) => pageIds[game][kind].map((pageId) => ({ game, pageId, kind }))));

function version(value: unknown): value is string {
  return typeof value === "string" && versions.test(value);
}

function targetVersion(manifest: unknown, game: Game): string | undefined {
  const { latest, available } = object(object(manifest)[game]);
  if (version(latest) && (game === "zzz" || !latest.includes("+")) && Array.isArray(available) && available.includes(latest)) return latest;
}

function publishedVersion(manifest: unknown, game: Game): string | undefined {
  const { live, available } = object(object(manifest)[game]);
  if (version(live) && !live.includes("+") && Array.isArray(available) && available.includes(live)) return live;
}

function newer(target: string, local: string, game: Game): boolean {
  if (!version(local) || (game !== "zzz" && local.includes("+"))) return false;
  const [targetCore = "", targetBuild] = target.split("+");
  const [localCore = "", localBuild] = local.split("+");
  const targetParts = targetCore.split(".").map(Number);
  const localParts = localCore.split(".").map(Number);
  for (let index = 0; index < Math.max(targetParts.length, localParts.length); index++) {
    const difference = (targetParts[index] ?? 0) - (localParts[index] ?? 0);
    if (difference) return difference > 0;
  }
  return game === "zzz" && targetBuild !== undefined && localBuild !== undefined && Number(targetBuild) > Number(localBuild);
}

function planVersionedPage(page: AtlasPlanPage & { readonly localVersion?: string },
  local: AtlasCandidateValidation | undefined, target: string | undefined): AtlasPlanEntry {
  if (local && !local.ok) return { ...page, kind: "versioned", action: "review", reason: "local-unverified" };
  if (!target) return { ...page, kind: "versioned", action: "review", reason: "manifest-unavailable" };
  if (page.localVersion === target) return { ...page, kind: "versioned", action: "current", targetVersion: target };
  if (page.localVersion && !newer(target, page.localVersion, page.game)) {
    return { ...page, kind: "versioned", action: "review", reason: "unproven-upgrade", targetVersion: target };
  }
  return { ...page, kind: "versioned", action: "fetch", targetVersion: target };
}

function buildPlan(entries: AtlasPlanEntry[]): AtlasUpdatePlan {
  const candidateRequirements = entries.flatMap((entry) => entry.action === "fetch"
    ? [{ game: entry.game, pageId: entry.pageId, version: entry.targetVersion }] : []);
  return { entries, candidateRequirements };
}

/** Pass undefined only for an explicitly empty installation. An invalid snapshot never authorizes writes. */
export function planAtlasUpdate(manifest: unknown, local: AtlasCandidateValidation | undefined,
  scope?: readonly AtlasPlanPage[]): AtlasUpdatePlan {
  const entries: AtlasPlanEntry[] = [];
  if (scope?.some(({ game, pageId }) => !trackedPages.some((page) => page.game === game && page.pageId === pageId))) {
    throw new TypeError("图鉴更新范围包含未识别的游戏或分类。");
  }
  for (const page of trackedPages) {
    const { game, pageId, kind } = page;
    if (scope && !scope.some((item) => item.game === game && item.pageId === pageId)) continue;
    const existing = local?.pages.find((item) => item.game === game && item.pageId === pageId);
    const current = { game, pageId, ...(existing ? { localVersion: existing.version } : {}) };
    if (kind === "challenge") {
      entries.push({ ...current, kind, action: "audit-rotation" });
      continue;
    }
    const requireLive = (game === "zzz" && (pageId === "character" || pageId === "monster" ||
      pageId === "equipment" || pageId === "weapon" || pageId === "achievement/achievement")) ||
      (game === "hsr" && (pageId === "relicset" || pageId === "monster" || pageId === "monstervalue" || isMonsterGroupPage(pageId))) || (game === "gi" && pageId === "artifact");
    const target = requireLive ? publishedVersion(manifest, game) : targetVersion(manifest, game);
    entries.push(planVersionedPage(current, local, target));
  }
  return buildPlan(entries);
}

/** ZZZ challenge acquisition uses the published build and verifies each source window separately. */
export function planPublishedChallengeRefresh(manifest: unknown, local: AtlasCandidateValidation,
  scope: { game: "zzz"; pageId: "boss" | "shiyu" } | { game: "hsr"; pageId: StarrailRotationPage }): AtlasUpdatePlan {
  const existing = local.pages.find(({ game, pageId }) => game === scope.game && pageId === scope.pageId);
  if (!existing) return buildPlan([{ ...scope, kind: "versioned", action: "review", reason: "local-unverified" }]);
  return buildPlan([planVersionedPage({ ...scope, localVersion: existing.version }, local, publishedVersion(manifest, scope.game))]);
}

export async function fetchAtlasManifest(signal?: AbortSignal): Promise<unknown> {
  const bytes = await readAtlasSourceBytes(atlasManifestUrl, "application/json", maxManifestBytes, false, signal, fetch, { retry: true });
  if (!bytes) throw new Error("图鉴版本清单不可用。");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

if (import.meta.main) {
  const [directory, manifestFile, ...extra] = Bun.argv.slice(2);
  if (!directory || extra.length) {
    console.error("用法：bun update-plan.ts <包含 map.json 的本地目录> [清单 JSON 文件]");
    process.exitCode = 2;
  } else {
    try {
      const local = await validateAtlasCandidate(directory);
      const manifest = manifestFile ? await Bun.file(manifestFile).json() : await fetchAtlasManifest();
      const plan = planAtlasUpdate(manifest, local);
      console.log(JSON.stringify(plan, null, 2));
      if (plan.entries.some(({ action }) => action === "review")) process.exitCode = 1;
    } catch {
      console.error("无法生成图鉴更新计划。请检查固定来源或本地清单文件。");
      process.exitCode = 1;
    }
  }
}
