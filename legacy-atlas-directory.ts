import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { atlasLocales, defaultAtlasLocale, type AtlasLocale } from "./locale.ts";
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { discoverAtlasDataDirectory } from "./snapshot-pointer.ts";

const formerPluginPaths = ["Lotus-Plugin", "Lotus-ReFactor"] as const;

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
  }
}

export class LegacyAtlasSourceConflict extends Error {
  constructor() {
    super($t("legacy-atlas-directory.text_46622f1071"));
  }
}

export async function findLegacyAtlasExport(atlasRoot: string, includeUnindexed = false, locale?: AtlasLocale): Promise<string | undefined> {
  const plugins = resolve(atlasRoot, "../../plugins");
  const sources = new Set<string>();
  for (const name of formerPluginPaths) {
    const exportRoot = join(plugins, name, "data", "atlas");
    const index = await lstatIfPresent(join(exportRoot, "data", "map.json"));
    if (!index) {
      if (!includeUnindexed) continue;
      const languages = locale ? [atlasLocales[locale]] : Object.values(atlasLocales);
      const directories = await Promise.all(languages.map(({ folder }) => lstatIfPresent(join(exportRoot, "data", "items", folder))));
      if (!directories.some(info => info?.isDirectory())) continue;
    }
    if (index && !index.isFile()) throw new Error($t("legacy-atlas-directory.text_1055dc7a7a"));
    const directory = await realpath(exportRoot);
    const data = join(directory, "data");
    if (await realpath(data) !== data) throw new Error($t("legacy-atlas-directory.text_249fbc657f"));
    sources.add(directory);
  }
  if (sources.size > 1) throw new LegacyAtlasSourceConflict();
  return sources.values().next().value;
}

export async function discoverRuntimeAtlasDataDirectory(atlasRoot: string, locale = defaultAtlasLocale) {
  // An existing primary marker owns the selection, even when it cannot be read.
  if (await lstatIfPresent(join(atlasRoot, "current")) || await lstatIfPresent(join(atlasRoot, "data"))) {
    return { ...await discoverAtlasDataDirectory(atlasRoot), legacy: false };
  }
  const source = await findLegacyAtlasExport(atlasRoot, true, locale);
  if (source) return { root: join(source, "data"), version: null, legacy: true };
  return { ...await discoverAtlasDataDirectory(atlasRoot), legacy: false };
}


// A theme and the publication lock are independent of the Atlas data itself.
export async function atlasRootIsEmpty(root: string): Promise<boolean> {
  const directory = resolve(root);
  for (let candidate = directory; ; candidate = dirname(candidate)) {
    const info = await lstatIfPresent(candidate);
    if (!info) continue;
    if (!info.isDirectory() || await realpath(candidate) !== candidate) return false;
    break;
  }
  if (await findLegacyAtlasExport(directory, true)) return false;
  if (!await lstatIfPresent(directory)) return true;

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "theme" && entry.isDirectory()) continue;
    if (entry.name === ".prepared" && entry.isDirectory()) continue;
    // BEGIN IMMEDIATE may create the rollback journal while the publication lock is held.
    if ((entry.name === ".publication.sqlite" || entry.name === ".publication.sqlite-journal") && entry.isFile()) continue;
    if (entry.name !== "snapshots" || !entry.isDirectory() || (await readdir(join(directory, entry.name))).length) {
      return false;
    }
  }
  return true;
}
