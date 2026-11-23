import { atlasLocaleBlock, atlasLocales, defaultAtlasLocale, parseAtlasLocale, type AtlasLocale } from "./locale.ts";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Game } from "./catalog.ts";
import { object } from "./source-values.ts";

export interface AtlasCandidatePage {
  readonly game: Game;
  readonly locale?: AtlasLocale;
  readonly pageId: string;
  readonly version?: string;
  readonly recordCount?: number;
}

export type ValidatedAtlasCandidatePage = Required<Omit<AtlasCandidatePage, "locale">> & Pick<AtlasCandidatePage, "locale">;

export interface AtlasCandidateValidation {
  readonly ok: boolean;
  readonly pages: readonly ValidatedAtlasCandidatePage[];
  readonly issueCount: number;
  readonly issues: readonly string[];
}

const games = ["gi", "hsr", "zzz"] as const;
const maxJsonBytes = 16 * 1024 * 1024;
const maxReportedIssues = 32;
const controls = /[\u0000-\u001f\u007f-\u009f]/u;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value && !controls.test(value);
}

function itemPath(value: unknown): value is string {
  return identity(value) && value.startsWith("items/") && value.endsWith(".json") && !value.includes("\\") &&
    value.split("/").every((part) => part && part !== "." && part !== "..");
}

export async function candidateJson(directory: string, relative: string): Promise<unknown> {
  const path = join(directory, relative);
  if (await realpath(path) !== path) throw new Error("快照文件路径经过链接。");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    const { size } = info;
    if (!info.isFile() || size === 0 || size > maxJsonBytes) throw new Error("快照文件大小不符。");
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw new Error("快照文件在读取时发生更改。");
      offset += bytesRead;
    }
    if ((await file.stat()).size !== size) throw new Error("快照文件在读取时发生更改。");
    return JSON.parse(utf8.decode(buffer)) as unknown;
  } finally {
    await file.close();
  }
}

function matchesItem(value: unknown, game: Game, pageId: string, version: string, locale: AtlasLocale, entry: Record<string, unknown>): boolean {
  const { meta, content } = object(value);
  return record(meta) && record(content) && meta.gameId === game && meta.pageId === pageId &&
    parseAtlasLocale(meta.locale) === locale && meta.recordId === entry.id && meta.name === entry.name && meta.version === version &&
    meta.hasDetail === entry.hasDetail && record(content.list) &&
    (entry.hasDetail ? record(content.detail) || Array.isArray(content.detail) : content.detail === null);
}

/** The path is the candidate's directory containing map.json and items/. */
export async function validateAtlasCandidate(directory: string, requiredPages: readonly AtlasCandidatePage[] = [],
  signal?: AbortSignal): Promise<AtlasCandidateValidation> {
  signal?.throwIfAborted();
  const pages: ValidatedAtlasCandidatePage[] = [];
  const issues: string[] = [];
  let issueCount = 0;
  function issue(message: string) {
    issueCount++;
    if (issues.length < maxReportedIssues) issues.push(message);
  }
  const result = (): AtlasCandidateValidation => ({ ok: issueCount === 0, pages, issueCount, issues });
  let root: string;
  let map: Record<string, unknown>;
  try {
    root = await realpath(directory);
    map = object(await candidateJson(root, "map.json"));
  } catch {
    issue("候选 map.json 缺失、不可读或不是实体 JSON 文件。");
    return result();
  }
  const registered = object(map.games);
  const usedPaths = new Set<string>();
  for (const game of games) {
    for (const locale of Object.keys(atlasLocales) as AtlasLocale[]) {
      for (const [pageId, value] of Object.entries(object(atlasLocaleBlock(registered[game], locale).pages))) {
        signal?.throwIfAborted();
        const where = locale === defaultAtlasLocale ? `${game}/${pageId}` : `${game}/${locale}/${pageId}`;
        const { id, version, records, recordCount, totalRecordCount, sampled } = object(value);
        const entries = Object.entries(object(records));
        if (!identity(pageId) || id !== pageId || !identity(version) || sampled !== false ||
            !entries.length || recordCount !== entries.length || totalRecordCount !== entries.length) {
          issue(`${controls.test(pageId) ? game : where} 的版本、采样标记或条目计数无效。`);
          continue;
        }
        const before = issueCount;
        for (const [key, value] of entries) {
          signal?.throwIfAborted();
          const entry = object(value);
          if (!identity(key) || entry.id !== key || !identity(entry.name) || typeof entry.hasDetail !== "boolean" ||
              !itemPath(entry.path) || usedPaths.has(entry.path)) {
            issue(`${where} 存在无效条目标识或重复文件路径。`);
            continue;
          }
          usedPaths.add(entry.path);
          try {
            const item = await candidateJson(root, entry.path);
            if (!matchesItem(item, game, pageId, version, locale, entry)) issue(`${where}/${key} 的身份、版本或详情结构不一致。`);
          } catch {
            issue(`${where}/${key} 的条目文件缺失、不可读或不是实体 JSON 文件。`);
          }
        }
        if (issueCount === before) pages.push({ game, pageId, version, recordCount, ...(locale !== defaultAtlasLocale && { locale }) });
      }
    }
  }
  signal?.throwIfAborted();
  if (!pages.length) issue("候选没有通过校验的图鉴分类。");
  for (const expected of requiredPages) {
    const page = pages.find(({ game, pageId, locale }) => game === expected.game && pageId === expected.pageId &&
      (locale ?? defaultAtlasLocale) === (expected.locale ?? defaultAtlasLocale));
    if (!page || (expected.version !== undefined && page.version !== expected.version) ||
        (expected.recordCount !== undefined && page.recordCount !== expected.recordCount)) {
      issue(`${expected.game}/${expected.pageId} 缺失、版本或条目计数与候选要求不符。`);
    }
  }
  return result();
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length !== 1 || !args[0]?.trim()) {
    console.error("用法：bun validate-candidate.ts <包含 map.json 的候选目录>");
    process.exitCode = 2;
  } else {
    const checked = await validateAtlasCandidate(args[0]);
    console.log(JSON.stringify(checked, null, 2));
    if (!checked.ok) process.exitCode = 1;
  }
}
