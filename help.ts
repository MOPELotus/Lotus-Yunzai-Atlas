import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nativeImageRasterScale } from "@lotus-yunzai/skia";
import { atlasThemeDirectories } from "./theme-directories.ts";
import type { AtlasImage } from "./traditional.ts";

export const atlasHelpAliases = { "图鉴帮助": "#图鉴帮助" };

const title = $t("help.text_9fd01ef12e");
const lead = $t("help.text_e250d03b82");
const rows = [
  $t("help.text_fbea48d29c"),
  $t("help.text_bb0c86266e"),
  $t("help.text_0a0d8db5be"),
  $t("help.text_ccc6b2cff8"),
  $t("help.text_e36378c363"),
  $t("help.text_922eeeb074"),
  $t("help.text_672eff0602"),
] as const;

export async function renderAtlasStatus(title: string, lead: string, rows: readonly string[], byteLimit?: number): Promise<AtlasImage | string> {
  try {
    const directories = atlasThemeDirectories(import.meta.url, Bun.env.LOTUS_ATLAS_THEME_DIR);
    const themeDirectory = directories.find((directory) => existsSync(join(directory, "bg", "bg-hydro.webp"))) ?? directories[0];
    const { renderStatusCard } = await import("@lotus-yunzai/skia/status-card");
    const scale = nativeImageRasterScale();
    for (const size of scale === 4 && byteLimit !== undefined ? [scale, 2] : [scale]) {
      const { png } = await renderStatusCard(title, lead, rows, new Date(), { themeDirectory, scale: size });
      if (byteLimit === undefined || png.byteLength <= byteLimit) return { type: "image", file: png };
    }
  } catch { /* Keep the same result available when Skia cannot render the card. */ }
  return [title, lead, ...rows].join("\n");
}

export const atlasHelp = () => renderAtlasStatus(title, lead, rows);
