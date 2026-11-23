import { atlasLocaleBlock, atlasLocales, atlasPageKey, defaultAtlasLocale, type AtlasLocale } from "./locale.ts";
import type { ValidatedAtlasCandidatePage } from "./validate-candidate.ts";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { candidateFile, candidateGallery, copyCandidateFile, type CandidateImageRecovery } from "./candidate-gallery.ts";
import type { Game } from "./catalog.ts";
import { object } from "./source-values.ts";
import { validateAtlasCandidate, type AtlasCandidatePage, type AtlasCandidateValidation } from "./validate-candidate.ts";

type ObjectValue = Record<string, unknown>;
type Page = ValidatedAtlasCandidatePage;
type Root = { readonly directory: string; readonly map: ObjectValue; readonly validated: readonly Page[] };
type SelectedPage = { readonly source: Root; readonly page: Page; readonly payload: ObjectValue };

export interface AtlasAssembledCandidate {
  readonly directory: string;
  readonly validation: AtlasCandidateValidation;
  readonly imageCount: number;
}

function inside(parent: string, path: string): boolean {
  const location = relative(parent, path);
  return location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location);
}

function overlaps(first: string, second: string): boolean {
  return inside(first, second) || inside(second, first);
}

function gameData(root: Root, game: Game): ObjectValue {
  return object(object(root.map.games)[game]);
}

function selectPage(source: Root, page: Page): SelectedPage {
  return { source, page, payload: object(object(atlasLocaleBlock(gameData(source, page.game), page.locale ?? defaultAtlasLocale).pages)[page.pageId]) };
}

async function readRoot(directory: string, required: readonly AtlasCandidatePage[], signal?: AbortSignal): Promise<Root> {
  const data = join(directory, "data");
  if (await realpath(data) !== data) throw new Error("快照 data 须为实体目录。");
  const validation = await validateAtlasCandidate(data, required, signal);
  if (!validation.ok) throw new Error(`源快照未通过校验。${validation.issues[0] ?? ""}`);
  const map = object(JSON.parse(await readFile(join(data, "map.json"), "utf8")));
  for (const key of Object.keys(object(map.games))) {
    if (!(key === "gi" || key === "hsr" || key === "zzz")) throw new Error("合成只接受三款已核对游戏的快照。");
  }
  return { directory, map, validated: validation.pages };
}

function describePages(baseline: Root, replacement: Root, scope: readonly AtlasCandidatePage[]): SelectedPage[] {
  const chosen = new Map<string, SelectedPage>();
  for (const source of [baseline, replacement]) {
    for (const page of source.validated) {
      if (source === replacement && !scope.some((request) => atlasPageKey(request) === atlasPageKey(page))) continue;
      chosen.set(atlasPageKey(page), selectPage(source, page));
    }
  }
  return [...chosen.values()];
}

function composeMap(baseline: Root, replacement: Root, pages: readonly SelectedPage[], scope: readonly AtlasCandidatePage[]) {
  const games: Record<string, unknown> = {};
  const selected = new Map<Game, string[]>();
  const requestedVersions: Record<string, string> = {};
  const availableLocales = new Set<AtlasLocale>();
  for (const part of scope) selected.set(part.game, [...selected.get(part.game) ?? [], part.pageId]);
  for (const game of ["gi", "hsr", "zzz"] as const) {
    const actual = pages.filter((item) => item.page.game === game);
    if (!actual.length) continue;
    const base = gameData(baseline, game);
    const current = gameData(replacement, game);
    const versions = [...new Set(actual.map(({ page }) => page.version))];
    const version = versions.length === 1 ? versions[0]! : null;
    if (version) requestedVersions[game] = version;
    const locales = Object.fromEntries((Object.keys(atlasLocales) as AtlasLocale[]).flatMap(locale => {
      const localized = actual.filter(({ page }) => (page.locale ?? defaultAtlasLocale) === locale);
      if (!localized.length) return [];
      availableLocales.add(locale);
      return [[locale, { ...atlasLocaleBlock(base, locale), ...atlasLocaleBlock(current, locale),
        pages: Object.fromEntries(localized.map(({ page, payload }) => [page.pageId, payload])) }]];
    }));
    games[game] = {
      ...base,
      game: { ...object(base.game), ...object(current.game), versions, requestedVersion: version },
      locales,
    };
  }
  const source = object(baseline.map.meta).source;
  return { meta: { source, mode: "merged", locales: [...availableLocales], selectedPages: Object.fromEntries(selected), requestedVersions }, games };
}

async function copyPages(pages: readonly SelectedPage[], gallery: ReturnType<typeof candidateGallery>, target: string, signal?: AbortSignal) {
  let detailCount = 0;
  for (const { source, page, payload } of pages) {
    for (const record of Object.values(object(payload.records))) {
      signal?.throwIfAborted();
      const path = object(record).path;
      if (typeof path !== "string" || !path.startsWith("items/")) throw new Error("源索引在合成期间改变。");
      const file = await candidateFile(join(source.directory, "data"), path);
      const destination = join(target, "data", path);
      if (!inside(join(target, "data", "items"), destination)) throw new Error("候选条目路径越界。");
      await copyCandidateFile(file, destination);
      const item: unknown = JSON.parse(await readFile(destination, "utf8"));
      if (object(object(item).meta).hasDetail === true) detailCount++;
      await gallery.include(item, page.game, source.directory, signal);
    }
  }
  return { imageCount: gallery.count, detailCount };
}

export async function copyAtlasCandidate(source: string, destination: string, scope: readonly Page[],
  counts: { readonly imageCount: number; readonly detailCount: number } | undefined, signal?: AbortSignal): Promise<AtlasAssembledCandidate> {
  return copyPagesFromAtlas(source, destination, scope, false, counts, signal);
}

export async function copyAtlasSelectedPages(source: string, destination: string, scope: readonly Page[],
  signal?: AbortSignal, recovery?: CandidateImageRecovery): Promise<AtlasAssembledCandidate> {
  return copyPagesFromAtlas(source, destination, scope, true, undefined, signal, recovery);
}

async function copyPagesFromAtlas(source: string, destination: string, scope: readonly Page[], subset: boolean,
  counts: { readonly imageCount: number; readonly detailCount: number } | undefined, signal?: AbortSignal, recovery?: CandidateImageRecovery) {
  signal?.throwIfAborted();
  const resolved = resolve(destination);
  const [base, parent] = await Promise.all([realpath(source), realpath(dirname(resolved))]);
  const target = join(parent, basename(resolved));
  if (overlaps(base, target)) throw new Error("图鉴源和候选目录必须独立。");
  const root = await readRoot(base, scope, signal);
  const keys = new Set(scope.map(atlasPageKey));
  if ((!subset && counts && root.validated.filter(page => !page.locale).length !== scope.filter(page => !page.locale).length) ||
      keys.size !== scope.length || !keys.size) {
    throw new Error("原图鉴导出的分类与已核定首版不同。");
  }
  const pages = root.validated.filter(page => !subset || keys.has(atlasPageKey(page))).map(page => selectPage(root, page));
  signal?.throwIfAborted();
  await mkdir(target, { mode: 0o700 });
  try {
    const gallery = candidateGallery(target, recovery);
    if (counts) {
      const { imageCount, detailCount } = await copyPages(pages.filter(({ page }) => !page.locale), gallery, target, signal);
      if (imageCount !== counts.imageCount || detailCount !== counts.detailCount) {
        throw new Error("原图鉴导出的详情或图库数量与已核定首版不符。");
      }
      await copyPages(pages.filter(({ page }) => page.locale), gallery, target, signal);
    } else {
      await copyPages(pages, gallery, target, signal);
    }
    const data = join(target, "data");
    const map = subset ? composeMap(root, root, pages, scope) : root.map;
    await writeFile(join(data, "map.json"), JSON.stringify(map) + "\n", { flag: "wx" });
    const validation = await validateAtlasCandidate(data, scope, signal);
    if (!validation.ok) throw new Error(`首版图鉴未通过校验。${validation.issues[0] ?? ""}`);
    return { directory: target, validation, imageCount: gallery.count };
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

/** Source roots contain data/map.json and optionally gallery/. The destination must not exist. */
export async function assembleAtlasCandidate(baseline: string, replacement: string, destination: string,
  scope: readonly AtlasCandidatePage[], signal?: AbortSignal, recovery?: CandidateImageRecovery): Promise<AtlasAssembledCandidate> {
  signal?.throwIfAborted();
  if (!scope.length || new Set(scope.map(atlasPageKey)).size !== scope.length) throw new Error("请选择一个或多个不重复的候选分类。");
  const resolved = resolve(destination);
  const [base, donor, parent] = await Promise.all([realpath(baseline), realpath(replacement), realpath(dirname(resolved))]);
  const target = join(parent, basename(resolved));
  if (overlaps(base, donor) || overlaps(base, target) || overlaps(donor, target)) {
    throw new Error("基线、更新源和合成目标必须是独立目录。");
  }
  const [existing, updates] = await Promise.all([readRoot(base, [], signal), readRoot(donor, scope, signal)]);
  const pages = describePages(existing, updates, scope);
  signal?.throwIfAborted();
  await mkdir(target, { mode: 0o700 });
  try {
    const { imageCount } = await copyPages(pages, candidateGallery(target, recovery), target, signal);
    const dataDirectory = join(target, "data");
    await writeFile(join(dataDirectory, "map.json"), JSON.stringify(composeMap(existing, updates, pages, scope)) + "\n", { flag: "wx" });
    const validation = await validateAtlasCandidate(dataDirectory, pages.map(({ page }) => page), signal);
    if (!validation.ok) throw new Error(`合成快照未通过校验。${validation.issues[0] ?? ""}`);
    return { directory: target, validation, imageCount };
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}
