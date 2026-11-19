import { mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { assembleAtlasCandidate } from "./assemble-candidate.ts";
import { atlasApplyStagingPrefix, publishPreparedAtlasCandidate, type AtlasPublication } from "./publish-candidate.ts";
import { discoverAtlasDataDirectory } from "./snapshot-pointer.ts";
import type { AtlasCandidatePage } from "./validate-candidate.ts";

function contains(parent: string, directory: string): boolean {
  const location = relative(parent, directory);
  return !isAbsolute(location) && location.split(sep)[0] !== "..";
}

/** Apply a prepared local snapshot to the explicitly selected publication root. */
export async function applyAtlasCandidate(root: string, source: string, scope: readonly AtlasCandidatePage[],
  signal?: AbortSignal, expected?: Awaited<ReturnType<typeof discoverAtlasDataDirectory>>): Promise<AtlasPublication> {
  signal?.throwIfAborted();
  if ([root, source].some((value) => !value.trim() || /^[a-z][a-z0-9+.-]*:\/\//iu.test(value))) {
    throw new Error("请指定图鉴根目录和本地更新源目录。");
  }
  const [directory, donor] = await Promise.all([realpath(root), realpath(source)]);
  if (contains(directory, donor) || contains(donor, directory)) throw new Error("图鉴根与本地更新源须为独立目录。");

  const baseline = await discoverAtlasDataDirectory(directory);
  if (expected && (expected.version !== baseline.version || expected.root !== baseline.root)) {
    return { status: "stale", current: baseline.version };
  }
  // Keep the stage outside the legacy snapshot (which occupies the publication root).
  const staging = await mkdtemp(join(dirname(directory), atlasApplyStagingPrefix));
  let result: AtlasPublication | undefined;
  try {
    const candidate = await assembleAtlasCandidate(dirname(baseline.root), donor, join(staging, "candidate"), scope, signal);
    result = await publishPreparedAtlasCandidate(directory, baseline.version, candidate.directory, candidate.validation.pages, signal);
    return result;
  } finally {
    // A successful promotion already removed the empty stage before committing the pointer.
    if (result?.status !== "published") await rm(staging, { recursive: true, force: true });
  }
}

function parseScope(value: string): AtlasCandidatePage | undefined {
  const match = /^(gi|hsr|zzz)\/([a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)*)(?:=([^\s=]+))?$/iu.exec(value);
  if (!match || match[0] !== value) return;
  const [, game, pageId, version] = match;
  if ((game === "gi" || game === "hsr" || game === "zzz") && pageId) {
    return { game, pageId, ...(version ? { version } : {}) };
  }
}

if (import.meta.main) {
  const [root, source, ...selections] = Bun.argv.slice(2);
  const scope = selections.map(parseScope);
  if (!root || !source || !scope.length || !scope.every((page): page is AtlasCandidatePage => page !== undefined)) {
    console.error("用法：bun apply-candidate.ts <图鉴根目录> <本地更新源目录> <gi/weapon[=版本]> [其他游戏/分类...]");
    process.exitCode = 2;
  } else {
    try {
      const result = await applyAtlasCandidate(root, source, scope);
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "published") process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : "图鉴更新失败。");
      process.exitCode = 1;
    }
  }
}
