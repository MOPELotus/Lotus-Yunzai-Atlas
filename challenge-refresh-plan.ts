import { changedAtlasSourceIndexes, readSelectedExporterIndexes,
  type AtlasExportPageSelection, type AtlasExportVersions } from "./download-legacy-atlas.ts";
import type { AtlasSourceFetch } from "./source-transport.ts";
import { atlasRotationPages } from "./update-policy.ts";
import type { AtlasCandidatePage } from "./validate-candidate.ts";

export async function planAtlasChallengeRefresh(baseline: string, current: readonly AtlasCandidatePage[],
  scope: readonly AtlasExportPageSelection[], versions: AtlasExportVersions,
  signal?: AbortSignal, request?: AtlasSourceFetch) {
  const versionChanges = scope.filter(({ game, pageId }) =>
    !current.some(page => page.game === game && page.pageId === pageId && page.version === versions[game]));
  const isRotation = ({ pageId }: AtlasExportPageSelection) => atlasRotationPages.has(pageId);
  const rotationGames = new Set(scope.filter(isRotation).map(({ game }) => game));
  const versionChanged = new Set(versionChanges.map(({ game, pageId }) => `${game}/${pageId}`));
  const probe = scope.filter(page => (isRotation(page) || !rotationGames.has(page.game)) &&
    !versionChanged.has(`${page.game}/${page.pageId}`));
  async function readChanges(pages: readonly AtlasExportPageSelection[]) {
    if (!pages.length) return [];
    const indexes = await readSelectedExporterIndexes(versions, signal, request, pages);
    return changedAtlasSourceIndexes(baseline, indexes, signal);
  }
  const rotationChanges = await readChanges(probe);
  const changedGames = new Set([...versionChanges, ...rotationChanges].filter(isRotation).map(({ game }) => game));
  const additional = scope.filter(page => versionChanged.has(`${page.game}/${page.pageId}`) ||
    (!isRotation(page) && changedGames.has(page.game)));
  return [...rotationChanges, ...await readChanges(additional)];
}
