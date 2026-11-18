import { fileURLToPath } from "node:url";
import { createAtlasCatalog, findCharacters, findEquipment, gameNames, type Game } from "./catalog.ts";

export { createAtlasCatalog, findCharacters, findEquipment } from "./catalog.ts";

const games = new Map<string, Game>([
  ["原神", "gi"], ["星铁", "hsr"], ["星穹铁道", "hsr"], ["绝区零", "zzz"],
]);
const catalog = createAtlasCatalog(Bun.env.LOTUS_ATLAS_DATA_DIR ||
  fileURLToPath(new URL("../../data/atlas/data/", import.meta.url)));
const missing = "图鉴数据不可用。请检查 LOTUS_ATLAS_DATA_DIR 指向的目录。";

function searchTerms(argument: string, fixedGame?: Game) {
  const words = argument.trim().split(/\s+/u);
  const statedGame = games.get(words[0] ?? "");
  if (statedGame) words.shift();
  return { game: fixedGame ?? statedGame, query: words.join(" "),
    mismatched: Boolean(fixedGame && statedGame && fixedGame !== statedGame) };
}

async function equipmentQuery(argument: string, command: string, fixedGame?: Game): Promise<string> {
  const { game, query, mismatched } = searchTerms(argument, fixedGame);
  if (mismatched && fixedGame) return `${command}用于查询${gameNames[fixedGame]}的装备。`;
  if (!query) return `用法：${command} ${fixedGame ? "" : "[原神|星铁|绝区零] "}名称或 ID`;
  try {
    const result = await catalog.read();
    const matches = findEquipment(result, query, game);
    if (!matches.length) return "未找到匹配的武器、光锥或音擎。";
    const lines = await Promise.all(matches.slice(0, 8).map(async (item) => {
      const { category, rarity, scope } = await catalog.equipmentFacts(item);
      return [gameNames[item.game], category, item.name, rarity || "等级待核对",
        scope || "适用范围待核对", `ID ${item.id}`].join(" · ");
    }));
    if (matches.length > lines.length) lines.push("结果较多，请补充游戏名或更完整的名称。");
    if (result.stale) lines.push("部分索引未更新，可发送 #图鉴状态 查看版本。");
    return lines.join("\n");
  } catch {
    return missing;
  }
}

export default {
  commands: {
    "#武器图鉴": (argument: string) => equipmentQuery(argument, "#武器图鉴"),
    "#光锥图鉴": (argument: string) => equipmentQuery(argument, "#光锥图鉴", "hsr"),
    "#音擎图鉴": (argument: string) => equipmentQuery(argument, "#音擎图鉴", "zzz"),
    async "#图鉴状态"(): Promise<string> {
      try {
        const result = await catalog.read();
        const lines = result.pages.map(({ game, name, version, entries, sampled }) =>
          `${gameNames[game]} · ${name} · ${version} · ${entries.length} 个条目${sampled ? "（样例）" : ""}`);
        if (result.stale) lines.push("部分索引更新失败，已有数据的分类保留了上一次可用的版本。");
        return lines.join("\n");
      } catch {
        return missing;
      }
    },
    async "#角色图鉴"(argument: string): Promise<string> {
      const { game, query } = searchTerms(argument);
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
        if (result.stale) lines.push("部分索引未更新，可发送 #图鉴状态 查看版本。");
        return lines.join("\n");
      } catch {
        return missing;
      }
    },
  },
};
