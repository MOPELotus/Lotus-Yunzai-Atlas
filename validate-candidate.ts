import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
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
  if (await realpath(path) !== path) throw new Error($t("validate-candidate.text_051bd6a1f6"));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    const { size } = info;
    if (!info.isFile() || size === 0 || size > maxJsonBytes) throw new Error($t("validate-candidate.text_f22262f2ee"));
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw new Error($t("validate-candidate.text_15096a2aa7"));
      offset += bytesRead;
    }
    if ((await file.stat()).size !== size) throw new Error($t("validate-candidate.text_15096a2aa7"));
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
    issue($t("validate-candidate.text_4d9d4608fb"));
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
          issue($t("validate-candidate.text_4dbab3954f", { "value1": controls.test(pageId) ? game : where }));
          continue;
        }
        const before = issueCount;
        for (const [key, value] of entries) {
          signal?.throwIfAborted();
          const entry = object(value);
          if (!identity(key) || entry.id !== key || !identity(entry.name) || typeof entry.hasDetail !== "boolean" ||
              !itemPath(entry.path) || usedPaths.has(entry.path)) {
            issue($t("validate-candidate.text_29cdaeeb9a", { "where": where }));
            continue;
          }
          usedPaths.add(entry.path);
          try {
            const item = await candidateJson(root, entry.path);
            if (!matchesItem(item, game, pageId, version, locale, entry)) issue($t("validate-candidate.text_e39ab8ff06", { "where": where, "key": key }));
          } catch {
            issue($t("validate-candidate.text_ba449948f4", { "where": where, "key": key }));
          }
        }
        if (issueCount === before) pages.push({ game, pageId, version, recordCount, ...(locale !== defaultAtlasLocale && { locale }) });
      }
    }
  }
  signal?.throwIfAborted();
  if (!pages.length) issue($t("validate-candidate.text_a6996f6891"));
  for (const expected of requiredPages) {
    const page = pages.find(({ game, pageId, locale }) => game === expected.game && pageId === expected.pageId &&
      (locale ?? defaultAtlasLocale) === (expected.locale ?? defaultAtlasLocale));
    if (!page || (expected.version !== undefined && page.version !== expected.version) ||
        (expected.recordCount !== undefined && page.recordCount !== expected.recordCount)) {
      issue($t("validate-candidate.text_6cd8318977", { "game": expected.game, "pageId": expected.pageId }));
    }
  }
  return result();
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length !== 1 || !args[0]?.trim()) {
    console.error($t("validate-candidate.text_b0f06f51d2"));
    process.exitCode = 2;
  } else {
    const checked = await validateAtlasCandidate(args[0]);
    console.log(JSON.stringify(checked, null, 2));
    if (!checked.ok) process.exitCode = 1;
  }
}
