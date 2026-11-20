import { existsSync } from "node:fs";
import { join } from "node:path";
import { atlasThemeDirectories } from "./theme-directories.ts";
import type { AtlasImage } from "./traditional.ts";

const command = "#图鉴帮助";
export const atlasHelpAliases = Object.fromEntries([
  "图鉴帮助", "#荷花图鉴帮助", "荷花图鉴帮助", "#Lotus图鉴帮助", "Lotus图鉴帮助",
  "#lotus图鉴帮助", "lotus图鉴帮助",
].map((alias) => [alias, command]));

const title = "图鉴帮助";
const lead = "Nanoka Atlas\n图鉴查询公开资料，个人战绩使用各游戏原命令。";
const rows = [
  "直查：#神里绫华图鉴 / *卡芙卡星魂 / %艾莲影画",
  "显式：#图鉴 原神 元素专家·第一辑 / #荷花图鉴 绝区零 星见雅",
  "挑战图鉴：#本期幻想图鉴 / *上期末日图鉴 / %上期危局图鉴",
  "成就分类：#成就分类 原神 元素专家·第一辑",
  "状态：#图鉴状态",
  "主人维护：#检查图鉴更新 / #更新图鉴",
  "数据目录：默认 data/atlas，可用 LOTUS_ATLAS_DATA_DIR 指定快照",
] as const;

export async function atlasHelp(): Promise<AtlasImage | string> {
  try {
    const directories = atlasThemeDirectories(import.meta.url, Bun.env.LOTUS_ATLAS_THEME_DIR);
    const themeDirectory = directories.find((directory) => existsSync(join(directory, "bg", "bg-hydro.webp"))) ?? directories[0];
    const { renderStatusCard } = await import("@lotus-yunzai/skia/status-card");
    const { png } = await renderStatusCard(title, lead, rows, new Date(), { themeDirectory });
    return { type: "image", file: png };
  } catch {
    return [title, lead, ...rows].join("\n");
  }
}
