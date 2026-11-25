import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { createHash } from "node:crypto";
import { matchesLegacyAtlasIndex, maxLegacyAtlasIndexBytes } from "./audit-legacy-source.ts";
import { legacyAtlasSourcePages } from "./legacy-source-profile.ts";
import type { openAtlasPinnedCache } from "./pinned-source-cache.ts";
import { atlasSourceOrigin, isAtlasSourceWebp } from "./source-transport.ts";
import { object } from "./source-values.ts";

export const legacyGenshinAchievementPage = "gi/achievement/achievement";
const page = legacyAtlasSourcePages.find(({ game, pageId }) => `${game}/${pageId}` === legacyGenshinAchievementPage)!;
// The 75 record IDs, paths, URLs, hashes and sizes were checked against every original WebP.
const topologySha256 = "0d4df77e80a00af5962821de773108afd94d763b98380b2a0a6cbd773459d3af";
const iconName = /^UI_AchievementIcon_[A-Za-z0-9_]{1,80}$/u;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export interface LegacyAchievementArtwork {
  readonly id: string;
  readonly icon: string;
  readonly path: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

type Cache = Awaited<ReturnType<typeof openAtlasPinnedCache>>;
type Reference = Omit<LegacyAchievementArtwork, "id" | "icon"> & { readonly fieldPath: string; readonly originalValue: string };

export async function readLegacyAchievementArtwork(records: ReadonlyMap<string, {
  readonly artwork: readonly Reference[];
  readonly placeholderReferences: number;
}>, checkpoints: Cache, signal?: AbortSignal) {
  const raw = await checkpoints.read(page.indexSha256, maxLegacyAtlasIndexBytes, signal);
  if (!raw || !matchesLegacyAtlasIndex(page, raw)) return;
  const index = object(JSON.parse(utf8.decode(raw)));
  const assets: LegacyAchievementArtwork[] = [];
  for (const [id, { artwork, placeholderReferences }] of records) {
    signal?.throwIfAborted();
    const { icon } = object(index[id]);
    const [art] = artwork;
    if (typeof icon !== "string" || !iconName.test(icon) || artwork.length !== 1 || !art || placeholderReferences !== 0 ||
        art.fieldPath !== "icon" || art.originalValue !== icon || art.url !== `${atlasSourceOrigin}/assets/gi/${icon}.webp` ||
        art.path !== `gallery/gi/${icon}.webp`) throw new Error($t("legacy-achievement-art.text_e3f16aa669", { "id": id }));
    assets.push({ id, icon, path: art.path, url: art.url, sha256: art.sha256, bytes: art.bytes });
  }
  const tuples = assets.map(({ id, icon, path, url, sha256, bytes }) => [id, icon, path, url, sha256, bytes] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const digest = createHash("sha256").update(JSON.stringify(tuples)).digest("hex");
  if (assets.length !== page.recordCount || digest !== topologySha256) throw new Error($t("legacy-achievement-art.text_6e5852299c"));
  return { version: page.version, assets } as const;
}

export async function readPinnedAchievementImage(asset: LegacyAchievementArtwork, checkpoints: Cache, signal?: AbortSignal) {
  const bytes = await checkpoints.read(asset.sha256, asset.bytes, signal);
  return bytes?.length === asset.bytes && isAtlasSourceWebp(bytes) ? bytes : undefined;
}
