import { fileURLToPath } from "node:url";
import { createAtlasCatalog, findCharacters, gameNames, type Game } from "./catalog.ts";

export { createAtlasCatalog, findCharacters } from "./catalog.ts";

const games = new Map<string, Game>([
  ["原神", "gi"], ["星铁", "hsr"], ["星穹铁道", "hsr"], ["绝区零", "zzz"],
]);
const catalog = createAtlasCatalog(Bun.env.LOTUS_ATLAS_DATA_DIR ||
  fileURLToPath(new URL("../../data/atlas/data/", import.meta.url)));
const missing = "图鉴数据不可用。请检查 LOTUS_ATLAS_DATA_DIR 指向的目录。";

export default {
  commands: {
    async "#图鉴状态"(): Promise<string> {
      try {
        const result = await catalog.read();
        const lines = result.pages.map(({ game, version, entries, sampled }) =>
          `${gameNames[game]} ${version} · ${entries.length} 个条目${sampled ? "（样例）" : ""}`);
        if (result.stale) lines.push("索引更新失败，正在使用上一次可用的索引。");
        return lines.join("\n");
      } catch {
        return missing;
      }
    },
    async "#角色图鉴"(argument: string): Promise<string> {
      const words = argument.trim().split(/\s+/u);
      const game = games.get(words[0] ?? "");
      if (game) words.shift();
      const query = words.join(" ");
      if (!query) return "用法：#角色图鉴 [原神|星铁|绝区零] 名称或 ID";

      try {
        const result = await catalog.read();
        const matches = findCharacters(result, query, game);
        if (!matches.length) return "未找到匹配的角色。";
        const lines = await Promise.all(matches.slice(0, 8).map(async (character) => {
          const rarity = await catalog.characterRarity(character);
          const rank = rarity || (character.game === "zzz" ? "等级待核对" : "");
          return [gameNames[character.game], character.name, rank, `ID ${character.id}`].filter(Boolean).join(" · ");
        }));
        if (matches.length > lines.length) lines.push("结果较多，请补充游戏名或更完整的角色名。");
        if (result.stale) lines.push("当前使用上一次可用的索引。");
        return lines.join("\n");
      } catch {
        return missing;
      }
    },
  },
};
