import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Game } from "./catalog.ts";
import { object } from "./source-values.ts";
import { validateAtlasCandidate, type AtlasCandidatePage, type AtlasCandidateValidation } from "./validate-candidate.ts";

type ObjectValue = Record<string, unknown>;
type Page = Required<AtlasCandidatePage>;
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

function pageKey({ game, pageId }: AtlasCandidatePage): string {
  return `${game}/${pageId}`;
}

function gameData(root: Root, game: Game): ObjectValue {
  return object(object(root.map.games)[game]);
}

function zh(root: Root, game: Game): ObjectValue {
  return object(object(gameData(root, game).locales).zh);
}

async function readRoot(directory: string, required: readonly AtlasCandidatePage[], signal?: AbortSignal): Promise<Root> {
  const data = join(directory, "data");
  if (await realpath(data) !== data) throw new Error("快照 data 须为实体目录。");
  const validation = await validateAtlasCandidate(data, required, signal);
  if (!validation.ok) throw new Error(`源快照未通过校验。${validation.issues[0] ?? ""}`);
  const map = object(JSON.parse(await readFile(join(data, "map.json"), "utf8")));
  for (const [key, value] of Object.entries(object(map.games))) {
    if (!(key === "gi" || key === "hsr" || key === "zzz") ||
        Object.keys(object(object(value).locales)).some((locale) => locale !== "zh")) {
      throw new Error("合成只接受三款已核对游戏的简体中文快照。");
    }
  }
  return { directory, map, validated: validation.pages };
}

function describePages(baseline: Root, replacement: Root, scope: readonly AtlasCandidatePage[]): SelectedPage[] {
  const chosen = new Map<string, SelectedPage>();
  for (const source of [baseline, replacement]) {
    for (const page of source.validated) {
      if (source === replacement && !scope.some((request) => pageKey(request) === pageKey(page))) continue;
      chosen.set(pageKey(page), { source, page, payload: object(object(zh(source, page.game).pages)[page.pageId]) });
    }
  }
  return [...chosen.values()];
}

function composeMap(baseline: Root, replacement: Root, pages: readonly SelectedPage[], scope: readonly AtlasCandidatePage[]) {
  const games: Record<string, unknown> = {};
  const selected = new Map<Game, string[]>();
  const requestedVersions: Record<string, string> = {};
  for (const part of scope) selected.set(part.game, [...selected.get(part.game) ?? [], part.pageId]);
  for (const game of ["gi", "hsr", "zzz"] as const) {
    const actual = pages.filter((item) => item.page.game === game);
    if (!actual.length) continue;
    if (!selected.has(game)) {
      games[game] = gameData(baseline, game);
      continue;
    }
    const base = gameData(baseline, game);
    const current = gameData(replacement, game);
    const versions = [...new Set(actual.map(({ page }) => page.version))];
    const version = versions.length === 1 ? versions[0]! : null;
    if (version) requestedVersions[game] = version;
    games[game] = {
      ...base,
      game: { ...object(base.game), ...object(current.game), versions, requestedVersion: version },
      locales: { zh: { ...zh(baseline, game), ...zh(replacement, game),
        pages: Object.fromEntries(actual.map(({ page, payload }) => [page.pageId, payload])) } },
    };
  }
  const source = object(baseline.map.meta).source;
  return { meta: { source, mode: "merged", locales: ["zh"], selectedPages: Object.fromEntries(selected), requestedVersions }, games };
}

async function physicalFile(root: string, path: string): Promise<string> {
  const source = join(root, path);
  if (!inside(root, source) || await realpath(source) !== source || !(await lstat(source)).isFile()) {
    throw new Error("快照引用的文件必须位于源目录内且为实体文件。");
  }
  return source;
}

async function copyNewFile(source: string, destination: string) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
}

async function hashFile(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

function referencedImage(image: ObjectValue, game: Game) {
  if (image.status !== "downloaded" && image.placeholder !== true) return;
  const { localPath: path, sha256 } = image;
  const placeholder = image.placeholder === true;
  if (typeof path !== "string" || /[\\\u0000-\u001f\u007f-\u009f]/u.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      (placeholder ? path !== "gallery/_placeholder/unknown.svg" : !path.startsWith(`gallery/${game}/`))) {
    throw new Error("源图片路径或哈希无效。");
  }
  if (placeholder) return { path, sha256: undefined };
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256)) throw new Error("源图片路径或哈希无效。");
  return { path, sha256 };
}

async function copyPages(pages: readonly SelectedPage[], target: string, signal?: AbortSignal) {
  const images = new Map<string, { sha256: string; sources: Set<string> }>();
  for (const { source, page, payload } of pages) {
    for (const record of Object.values(object(payload.records))) {
      signal?.throwIfAborted();
      const path = object(record).path;
      if (typeof path !== "string" || !path.startsWith("items/")) throw new Error("源索引在合成期间改变。");
      const file = await physicalFile(join(source.directory, "data"), path);
      const destination = join(target, "data", path);
      if (!inside(join(target, "data", "items"), destination)) throw new Error("候选条目路径越界。");
      await copyNewFile(file, destination);
      const { images: list } = object(object(JSON.parse(await readFile(destination, "utf8"))).meta);
      for (const row of Array.isArray(list) ? list : []) {
        signal?.throwIfAborted();
        const asset = referencedImage(object(row), page.game);
        if (!asset) continue;
        const earlier = images.get(asset.path);
        if (earlier && asset.sha256 && earlier.sha256 !== asset.sha256) throw new Error(`图库路径冲突：${asset.path}`);
        if (earlier?.sources.has(source.directory)) continue;
        const imageFile = await physicalFile(source.directory, asset.path);
        const checksum = await hashFile(imageFile, signal);
        if ((asset.sha256 && checksum !== asset.sha256) || (earlier && earlier.sha256 !== checksum)) {
          throw new Error(`图库文件内容与记录不符：${asset.path}`);
        }
        if (earlier) earlier.sources.add(source.directory);
        else {
          const output = join(target, asset.path);
          await copyNewFile(imageFile, output);
          if (await hashFile(output, signal) !== checksum) throw new Error(`复制时图库文件发生变化：${asset.path}`);
          images.set(asset.path, { sha256: checksum, sources: new Set([source.directory]) });
        }
      }
    }
  }
  return images.size;
}

/** Source roots contain data/map.json and optionally gallery/. The destination must not exist. */
export async function assembleAtlasCandidate(baseline: string, replacement: string, destination: string,
  scope: readonly AtlasCandidatePage[], signal?: AbortSignal): Promise<AtlasAssembledCandidate> {
  signal?.throwIfAborted();
  if (!scope.length || new Set(scope.map(pageKey)).size !== scope.length) throw new Error("请选择一个或多个不重复的候选分类。");
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
    const imageCount = await copyPages(pages, target, signal);
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
