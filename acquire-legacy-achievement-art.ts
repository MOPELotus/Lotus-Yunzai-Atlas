import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { legacyGenshinAchievementPage, readLegacyAchievementArtwork, readPinnedAchievementImage } from "./legacy-achievement-art.ts";
import { readLegacyExportInventory } from "./legacy-coverage.ts";
import { openAtlasPinnedCache } from "./pinned-source-cache.ts";
import { isAtlasSourceWebp, readAtlasSourceBytes, type AtlasSourceFetch } from "./source-transport.ts";

const maxRequestsPerRun = 8;

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return !isAbsolute(path) && path.split(sep)[0] !== "..";
}

/** Fetch only icons proved by the fixed version index and the independently recorded original artwork. */
export async function acquireLegacyAchievementArtwork(source: string, cache: string, { maxRequests = 4, request = fetch, signal }: {
  readonly maxRequests?: number;
  readonly request?: AtlasSourceFetch;
  readonly signal?: AbortSignal;
} = {}) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 0 || maxRequests > maxRequestsPerRun) {
    throw new Error($t("acquire-legacy-achievement-art.text_7e9794be5b", { "maxRequestsPerRun": maxRequestsPerRun }));
  }
  const [reference, directory] = await Promise.all([realpath(source), realpath(cache)]);
  if (contains(reference, directory) || contains(directory, reference)) throw new Error($t("acquire-legacy-achievement-art.text_767849c6ed"));
  const checkpoints = await openAtlasPinnedCache(cache);
  const inventory = await readLegacyExportInventory(reference, signal);
  const fixed = await readLegacyAchievementArtwork(inventory.pages.get(legacyGenshinAchievementPage)!, checkpoints, signal);
  if (!fixed) throw new Error($t("acquire-legacy-achievement-art.text_6a77aab057"));
  const files = [];
  let requests = 0;
  for (const asset of fixed.assets) {
    signal?.throwIfAborted();
    let state: "cached" | "downloaded" | "pending" | "request-failed" | "content-mismatch" = "pending";
    if (await readPinnedAchievementImage(asset, checkpoints, signal)) state = "cached";
    else if (requests < maxRequests) {
      requests++;
      const bytes = await readAtlasSourceBytes(asset.url, "image/webp", asset.bytes, false, signal, request).catch(() => undefined);
      signal?.throwIfAborted();
      if (!bytes) state = "request-failed";
      else if (bytes.length !== asset.bytes || !isAtlasSourceWebp(bytes) || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
        state = "content-mismatch";
      } else {
        await checkpoints.write(asset.sha256, bytes, signal);
        state = "downloaded";
      }
    }
    files.push({ ...asset, state });
  }
  const verified = files.filter(({ state }) => state === "cached" || state === "downloaded").length;
  return { status: verified === files.length ? "original-artwork-ready" : "incomplete", version: fixed.version,
    requests, verified, missing: files.length - verified, files } as const;
}

if (import.meta.main) {
  const [source, cache, budget, ...extra] = Bun.argv.slice(2);
  if (!source || !cache || extra.length || (budget !== undefined && !/^\d+$/u.test(budget))) {
    console.error($t("acquire-legacy-achievement-art.text_43d8588528"));
    process.exitCode = 2;
  } else {
    try {
      const report = await acquireLegacyAchievementArtwork(source, cache, { maxRequests: budget === undefined ? undefined : Number(budget) });
      console.log(JSON.stringify(report, null, 2));
      if (report.files.some(({ state }) => state === "request-failed" || state === "content-mismatch")) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : $t("acquire-legacy-achievement-art.text_fdff79bddc"));
      process.exitCode = 1;
    }
  }
}
