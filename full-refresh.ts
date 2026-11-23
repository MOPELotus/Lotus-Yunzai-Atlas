import { mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assembleAtlasCandidate } from "./assemble-candidate.ts";
import { candidateFile, copyCandidateFile, hashCandidateFile } from "./candidate-gallery.ts";
import { challengeArtworkDigests } from "./challenge-artwork.ts";
import { redownloadAtlasVersion } from "./download-legacy-atlas.ts";
import { legacyAtlasSourcePages } from "./legacy-source-profile.ts";
import { atlasApplyStagingPrefix, publishPreparedAtlasCandidate, type AtlasPreparation, type AtlasPublication } from "./publish-candidate.ts";
import { inspectFullAtlasCandidate } from "./refresh-source.ts";
import { discoverAtlasDataDirectory } from "./snapshot-pointer.ts";
import { acquireAtlasSource } from "./source-acquisition.ts";
import type { AtlasSourceFetch } from "./source-transport.ts";
import { atlasManifestVersion, isNewerAtlasVersion, type AtlasVersionChannel } from "./update-plan.ts";
import { validateAtlasCandidate } from "./validate-candidate.ts";

type FullRefreshResult = AtlasPublication | { readonly status: "current"; readonly version: number | null }
  | { readonly status: "review"; readonly reason: "unverified" | "manifest" | "older" };

async function findPinnedArtwork(base: string, path: string, sha256: string, signal?: AbortSignal) {
  for (const root of [base, dirname(base)]) {
    const source = await candidateFile(root, path).catch(() => undefined);
    if (source && await hashCandidateFile(source, signal) === sha256) return source;
  }
}

async function retainChallengeArtwork(base: string, candidate: string, signal?: AbortSignal) {
  for (const [path, sha256] of challengeArtworkDigests) {
    signal?.throwIfAborted();
    const original = await findPinnedArtwork(base, path, sha256, signal);
    if (!original) continue;
    const destination = join(candidate, path);
    const existing = await candidateFile(candidate, path).catch(() => undefined);
    if (!existing) await copyCandidateFile(original, destination);
    if (await hashCandidateFile(destination, signal) !== sha256) {
      throw new Error(`全量图鉴候选中的固定副本与原图不符：${path}`);
    }
  }
}

/** Reacquire all maintained pages without changing what queries can read until the candidate has passed review. */
export async function refreshFullAtlasFromPublic(root: string, workspace: string, channel: AtlasVersionChannel,
  readManifest: (signal?: AbortSignal) => Promise<unknown>, request?: AtlasSourceFetch, signal?: AbortSignal,
  preparation?: AtlasPreparation): Promise<FullRefreshResult> {
  signal?.throwIfAborted();
  const directory = await realpath(root);
  const active = await discoverAtlasDataDirectory(directory);
  if (active.version === null && active.root !== join(directory, "data")) return { status: "review", reason: "unverified" };
  const local = await validateAtlasCandidate(active.root, [], signal);
  if (!local.ok) return { status: "review", reason: "unverified" };
  const listing = await readManifest(signal).catch(() => undefined);
  signal?.throwIfAborted();
  const gi = atlasManifestVersion(listing, "gi", channel);
  const hsr = atlasManifestVersion(listing, "hsr", channel);
  const zzz = atlasManifestVersion(listing, "zzz", channel);
  if (!gi || !hsr || !zzz) return { status: "review", reason: "manifest" };
  const versions = { gi, hsr, zzz };
  const sourceScope = legacyAtlasSourcePages.map(({ game, pageId }) => ({ game, pageId, version: versions[game] }));
  const cardsPage = { game: "gi", pageId: "gcg", version: gi } as const;
  const scope = [...sourceScope, cardsPage];
  if (scope.some(({ game, pageId, version }) => {
    const previous = local.pages.find(page => page.game === game && page.pageId === pageId);
    return previous && previous.version !== version && !isNewerAtlasVersion(version, previous.version, game);
  })) return { status: "review", reason: "older" };

  return await redownloadAtlasVersion<FullRefreshResult>(workspace, directory, versions, async (source, pages) => {
    if (pages.length !== sourceScope.length || sourceScope.some(({ game, pageId, version }) =>
      !pages.some(page => page.game === game && page.pageId === pageId && page.version === version))) {
      return { status: "invalid", issues: ["来源缺少全量更新要求的分类。"] };
    }
    const stage = await mkdtemp(join(dirname(directory), atlasApplyStagingPrefix));
    let result: FullRefreshResult | undefined;
    try {
      const cards = await acquireAtlasSource(join(stage, "cards"), [cardsPage], signal, request);
      const donor = await assembleAtlasCandidate(source, cards.directory, join(stage, "source"), cards.pages, signal);
      const candidate = await assembleAtlasCandidate(dirname(active.root), donor.directory, join(stage, "candidate"), scope, signal);
      await retainChallengeArtwork(active.root, candidate.directory, signal);
      const review = await inspectFullAtlasCandidate(active.root, join(candidate.directory, "data"), scope, signal);
      if (review.issues.length) return { status: "invalid", issues: review.issues };
      // The publisher removes an empty stage while holding the publication lock.
      await Promise.all([donor.directory, cards.directory].map(path => rm(path, { recursive: true, force: true })));
      if (review.unchanged) {
        const current = await discoverAtlasDataDirectory(directory).catch(() => undefined);
        return current?.root === active.root && current.version === active.version
          ? { status: "current", version: active.version } : { status: "stale", current: current?.version ?? null };
      }
      result = await publishPreparedAtlasCandidate(directory, active.version, candidate.directory, candidate.validation.pages,
        signal, false, preparation);
      return result;
    } finally {
      if (result?.status !== "published" && result?.status !== "prepared") await rm(stage, { recursive: true, force: true });
    }
  }, signal, request, legacyAtlasSourcePages, active.root);
}
