import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { parseAtlasLocale } from "./locale.ts";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { assembleAtlasCandidate } from "./assemble-candidate.ts";
import { atlasApplyStagingPrefix, publishPreparedAtlasCandidate, readAtlasSnapshotVersion,
  type AtlasPublicationOptions, type AtlasPublication } from "./publish-candidate.ts";
import { discoverAtlasDataDirectory } from "./snapshot-pointer.ts";
import type { AtlasCandidatePage } from "./validate-candidate.ts";

function contains(parent: string, directory: string): boolean {
  const location = relative(parent, directory);
  return !isAbsolute(location) && location.split(sep)[0] !== "..";
}

/** Apply a prepared local snapshot to the explicitly selected publication root. */
export async function applyAtlasCandidate(root: string, source: string, scope: readonly AtlasCandidatePage[],
  signal?: AbortSignal, expected?: Awaited<ReturnType<typeof discoverAtlasDataDirectory>>,
  publication?: AtlasPublicationOptions): Promise<AtlasPublication> {
  signal?.throwIfAborted();
  if ([root, source].some((value) => !value.trim() || /^[a-z][a-z0-9+.-]*:\/\//iu.test(value))) {
    throw new Error($t("apply-candidate.text_28893f89d5"));
  }
  const [directory, donor] = await Promise.all([realpath(root), realpath(source)]);
  if (contains(directory, donor) || contains(donor, directory)) throw new Error($t("apply-candidate.text_bc3c38d066"));

  const staged = publication?.preparation?.baseline;
  const baseline = staged ?? await discoverAtlasDataDirectory(directory);
  const current = staged ? await readAtlasSnapshotVersion(directory) : baseline.version;
  if (current !== baseline.version || expected && (expected.version !== baseline.version || expected.root !== baseline.root)) {
    return { status: "stale", current };
  }
  // Keep the stage outside the legacy snapshot (which occupies the publication root).
  const staging = await mkdtemp(join(dirname(directory), atlasApplyStagingPrefix));
  let result: AtlasPublication | undefined;
  try {
    const candidate = await assembleAtlasCandidate(dirname(baseline.root), donor, join(staging, "candidate"), scope, signal);
    result = await publishPreparedAtlasCandidate(directory, baseline.version, candidate.directory, candidate.validation.pages,
      signal, false, publication);
    return result;
  } finally {
    // A successful promotion already removed the empty stage before committing the pointer.
    if (result?.status !== "published" && result?.status !== "prepared") await rm(staging, { recursive: true, force: true });
  }
}

function parseScope(value: string): AtlasCandidatePage | undefined {
  const match = /^(gi|hsr|zzz)\/(?:(zh|cht|en|ja|ko)\/)?([a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)*)(?:=([^\s=]+))?$/iu.exec(value);
  if (!match || match[0] !== value) return;
  const [, game, language, pageId, version] = match;
  if ((game === "gi" || game === "hsr" || game === "zzz") && pageId) {
    const locale = parseAtlasLocale(language);
    return { game, pageId, ...(version && { version }), ...(locale && { locale }) };
  }
}

if (import.meta.main) {
  const [root, source, ...selections] = Bun.argv.slice(2);
  const scope = selections.map(parseScope);
  if (!root || !source || !scope.length || !scope.every((page): page is AtlasCandidatePage => page !== undefined)) {
    console.error($t("apply-candidate.text_97d0630a08"));
    process.exitCode = 2;
  } else {
    try {
      const result = await applyAtlasCandidate(root, source, scope);
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "published") process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : $t("apply-candidate.text_e524ef4b20"));
      process.exitCode = 1;
    }
  }
}
