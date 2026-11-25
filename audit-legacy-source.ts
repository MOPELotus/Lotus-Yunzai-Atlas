import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { createHash } from "node:crypto";
import { legacyAtlasSourcePages, type LegacyAtlasSourcePage } from "./legacy-source-profile.ts";
import { atlasSourceOrigin, readAtlasSourceBytes, type AtlasSourceFetch } from "./source-transport.ts";
import { object } from "./source-values.ts";
import { fetchAtlasManifest } from "./update-plan.ts";

export const maxLegacyAtlasIndexBytes = 2 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

type IndexState = "verified" | "version-unavailable" | "request-failed" | "content-mismatch";

export function matchesLegacyAtlasIndex(page: LegacyAtlasSourcePage, bytes: Uint8Array): boolean {
  if (bytes.byteLength > maxLegacyAtlasIndexBytes || createHash("sha256").update(bytes).digest("hex") !== page.indexSha256) return false;
  try {
    const data: unknown = JSON.parse(utf8.decode(bytes));
    return page.indexShape === "array" ? Array.isArray(data) && data.length === page.recordCount
      : Object.keys(object(data)).length === page.recordCount;
  } catch {
    return false;
  }
}

/** Verify the fixed legacy indexes without acquiring full details, artwork, or a publishable snapshot. */
export async function auditLegacyAtlasSource({ manifest = fetchAtlasManifest, request = fetch, signal }: {
  readonly manifest?: typeof fetchAtlasManifest;
  readonly request?: AtlasSourceFetch;
  readonly signal?: AbortSignal;
} = {}) {
  signal?.throwIfAborted();
  const versions = object(await manifest(signal).catch(() => undefined));
  const pages = [];
  for (const page of legacyAtlasSourcePages) {
    signal?.throwIfAborted();
    const { game, pageId, version, recordCount, indexPath } = page;
    const url = `${atlasSourceOrigin}${indexPath}`;
    const { available } = object(versions[game]);
    let state: IndexState;
    if (!Array.isArray(available) || !available.includes(version)) {
      state = "version-unavailable";
    } else {
      const bytes = await readAtlasSourceBytes(url, "application/json", maxLegacyAtlasIndexBytes, false, signal, request).catch(() => undefined);
      signal?.throwIfAborted();
      state = bytes ? matchesLegacyAtlasIndex(page, bytes) ? "verified" : "content-mismatch" : "request-failed";
    }
    pages.push({ game, pageId, version, recordCount, url, state });
  }
  const verified = pages.filter(({ state }) => state === "verified");
  return { status: verified.length === pages.length ? "indexes-verified" : "review", pages,
    verifiedRecordCount: verified.reduce((count, page) => count + page.recordCount, 0) } as const;
}

if (import.meta.main) {
  if (Bun.argv.length !== 2) {
    console.error($t("audit-legacy-source.text_7a852fed09"));
    process.exitCode = 2;
  } else {
    const report = await auditLegacyAtlasSource();
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "indexes-verified") process.exitCode = 1;
  }
}
