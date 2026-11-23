import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { candidateJson } from "./validate-candidate.ts";
import { atlasSourceOrigin } from "./source-transport.ts";
import { object } from "./source-values.ts";

const localeDirectory = "items/简体中文";
const gameFolders = new Map([["gi", "原神"], ["hsr", "星铁"], ["zzz", "绝区零"]]);
const maxEntries = 20_000;
const safeId = /^[a-z0-9_][a-z0-9_.+-]{0,127}$/iu;
const safePage = /^[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)*$/iu;

interface Entry {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly rarity: string;
}

interface Page {
  readonly version: string;
  readonly sourceUrl: string;
  readonly records: Map<string, Entry>;
}

function validName(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 512 &&
    !/[\p{Cc}\p{Cf}]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeFolder(value: string) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").replace(/\s+/gu, " ").trim() || "_";
}

function invalid() {
  return new Error("旧图鉴条目树含无效、重复或跨来源记录，无法恢复索引。");
}

// The fixed old exporter used 语言/游戏/分类/稀有度/展示名.json. The native exporter uses game/page/id.json.
export async function rebuildLegacyAtlasIndex(root: string): Promise<Buffer> {
  const games = new Map<string, Map<string, Page>>();
  let entries = 0;

  async function visit(relative: string, parts: readonly string[]) {
    const directory = join(root, relative);
    if (parts.length > 7 || await realpath(directory) !== directory) throw invalid();
    const contents = await readdir(directory, { withFileTypes: true });
    contents.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const file of contents) {
      if (file.isSymbolicLink() || /[\\\p{Cc}]/u.test(file.name)) throw invalid();
      if (!parts.length && file.isDirectory() && (file.name === "异环" || file.name === "nte")) continue;
      const path = `${relative}/${file.name}`;
      if (file.isDirectory()) await visit(path, [...parts, file.name]);
      else if (file.name.endsWith(".json")) {
        if (!file.isFile() || ++entries > maxEntries) throw invalid();
        addItem(await candidateJson(root, path), path, parts, file.name);
      }
    }
  }

  function addItem(value: unknown, path: string, parts: readonly string[], filename: string) {
    const { meta, content } = object(value);
    const { gameId, gameFolder, locale, localeFolder, pageId, pageFolder, recordId, name, rarity, version, sourceUrl, sourcePath, hasDetail } = object(meta);
    const { list, detail } = object(content);
    if (typeof gameId !== "string" || gameFolders.get(gameId) !== gameFolder || typeof gameFolder !== "string" ||
        locale !== "zh" || localeFolder !== "简体中文" || !validName(pageFolder) || !validName(rarity) || !validName(name) ||
        typeof recordId !== "string" || !safeId.test(recordId) || typeof version !== "string" || !safeId.test(version) ||
        typeof pageId !== "string" || !safePage.test(pageId) || typeof sourcePath !== "string" ||
        !sourcePath.startsWith(`${version}/`) || !/^[a-z0-9_.+-]+(?:\/[a-z0-9_-]+)*\/[a-z0-9_-]+\.json$/iu.test(sourcePath) ||
        sourceUrl !== `${atlasSourceOrigin}/${gameId}/${sourcePath}` || !isRecord(list) || typeof hasDetail !== "boolean" ||
        (hasDetail ? !isRecord(detail) && !Array.isArray(detail) : detail !== null)) throw invalid();
    if (sourcePath.slice(version.length + 1, -".json".length).replace(/^zh\//u, "") !== pageId) throw invalid();
    const folder = parts.join("/");
    const originalFolder = [gameFolder, pageFolder, rarity].map(sanitizeFolder).join("/");
    const originalName = sanitizeFolder(name);
    const original = folder === originalFolder && (filename === `${originalName}.json` || filename === `${originalName}__${recordId}.json`);
    const native = folder === `${gameId}/${pageId}` && filename === `${recordId}.json`;
    if (!original && !native) throw invalid();

    const pages = games.get(gameId) ?? new Map<string, Page>();
    games.set(gameId, pages);
    const page = pages.get(pageId) ?? { version, sourceUrl, records: new Map<string, Entry>() };
    if (page.version !== version || page.sourceUrl !== sourceUrl || page.records.has(recordId)) throw invalid();
    page.records.set(recordId, { id: recordId, name, rarity, path });
    pages.set(pageId, page);
  }

  await visit(localeDirectory, []);
  if (!games.size) throw invalid();
  const indexedGames = [...games].map(([game, pages]) => {
    const indexedPages = [...pages].map(([id, { records, version, sourceUrl }]) => [id, {
      version, sourceUrl, recordCount: records.size, records: Object.fromEntries(records),
    }] as const);
    return [game, { locales: { zh: { pages: Object.fromEntries(indexedPages) } } }] as const;
  });
  return Buffer.from(JSON.stringify({ games: Object.fromEntries(indexedGames) }));
}
