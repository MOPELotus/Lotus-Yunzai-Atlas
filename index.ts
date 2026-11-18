import { fileURLToPath } from "node:url";
import { challengeModes, findChallengeMode } from "./challenges.ts";
import { compareKey } from "./source-values.ts";
import { findAchievementCategories, findAchievements, type AchievementCategory } from "./achievements.ts";
import { createAtlasCatalog, findBangboos, findSets, findCharacters, findEquipment, gameNames, type Game } from "./catalog.ts";

export { findAchievementCategories, findAchievements } from "./achievements.ts";
export { createAtlasCatalog, findBangboos, findSets, findCharacters, findEquipment } from "./catalog.ts";

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

async function setsQuery(argument: string, command: string, fixedGame?: Game): Promise<string> {
  const { game, query, mismatched } = searchTerms(argument, fixedGame);
  if (mismatched && fixedGame) return `${command}用于查询${gameNames[fixedGame]}的套装。`;
  if (!query) return `用法：${command} ${fixedGame ? "" : "[原神|星铁|绝区零] "}套装名或 ID`;
  try {
    const result = await catalog.read();
    const matches = findSets(result, query, game);
    if (!matches.length) return "未找到匹配的套装。";
    const lines = await Promise.all(matches.slice(0, 8).map(async (item) => {
      const { category, effects } = await catalog.setFacts(item);
      const header = [gameNames[item.game], category, item.name, `ID ${item.id}`].join(" · ");
      if (matches.length > 1) return header;
      return [header, ...(effects.length ? effects.map(({ pieces, text }) =>
        `${pieces}件套 · ${text || "效果待核对"}`) : ["套装效果待核对"])].join("\n");
    }));
    if (matches.length > lines.length) lines.push("结果较多，请补充游戏名或更完整的套装名。");
    if (result.stale) lines.push("部分索引未更新，可发送 #图鉴状态 查看版本。");
    return lines.join("\n");
  } catch {
    return missing;
  }
}

async function bangbooQuery(argument: string): Promise<string> {
  const { query, mismatched } = searchTerms(argument, "zzz");
  if (mismatched) return "#邦布图鉴用于查询绝区零的邦布。";
  if (!query) return "用法：#邦布图鉴 名称或 ID";
  try {
    const result = await catalog.read();
    const matches = findBangboos(result, query);
    if (!matches.length) return "未找到匹配的邦布。";
    const lines = await Promise.all(matches.slice(0, 8).map(async (item) =>
      ["绝区零", "邦布", item.name, await catalog.bangbooRarity(item) || "等级待核对", `ID ${item.id}`].join(" · ")));
    if (matches.length > lines.length) lines.push("结果较多，请补充更完整的邦布名。");
    if (result.stale) lines.push("部分索引未更新，可发送 #图鉴状态 查看版本。");
    return lines.join("\n");
  } catch {
    return missing;
  }
}

function achievementCategoryLabel(category: AchievementCategory): string {
  return [gameNames[category.game], category.parent, category.name].filter(Boolean).join(" · ");
}

async function achievementQuery(argument: string): Promise<string> {
  const { game, query } = searchTerms(argument);
  if (!query) return "用法：#成就图鉴 [原神|星铁|绝区零] 成就名或 ID";
  try {
    const result = await catalog.read();
    const categories = result.pages.flatMap((page) => page.achievementCategories ?? []);
    const matches = findAchievements(categories, query, game);
    if (!matches.length) return "未找到匹配的成就。";

    const lines = matches.slice(0, 8).map(({ category, entry }) => {
      const title = `${achievementCategoryLabel(category)} · ${entry.name} · ID ${entry.id}`;
      return matches.length <= 8 && entry.description ? `${title}\n${entry.description}` : title;
    });
    if (matches.length > lines.length) lines.push(`共 ${matches.length} 条，请补充游戏名或更完整的成就名。`);
    if (result.stale) lines.push("部分索引未更新，可发送 #图鉴状态 查看版本。");
    return lines.join("\n");
  } catch {
    return missing;
  }
}

async function achievementCategoryQuery(argument: string): Promise<string> {
  const { game, query } = searchTerms(argument);
  const suffix = /(?:^|\s+)第(\d+)页$/u.exec(query);
  const pageNo = suffix ? Number(suffix[1]) : 1;
  const name = suffix ? query.slice(0, suffix.index).trimEnd() : query;
  if (!Number.isSafeInteger(pageNo) || pageNo < 1) return "页码须为正整数。";
  try {
    const result = await catalog.read();
    const all = result.pages.flatMap((page) => page.achievementCategories ?? []);
    const categories = findAchievementCategories(all, name, game);
    if (!categories.length) return "未找到匹配的成就分类。";

    const [category] = categories;
    const selected = name && categories.length === 1 ? category : undefined;
    const lines = selected ? selected.entries.map(({ id, name }) => `${name} · ID ${id}`)
      : categories.map((item) => `${achievementCategoryLabel(item)} · ${item.entries.length} 项 · ID ${item.id}`);
    const pageSize = 12;
    const lastPage = Math.max(1, Math.ceil(lines.length / pageSize));
    if (pageNo > lastPage) return `共 ${lastPage} 页，请调整页码。`;

    const header = selected
      ? `${achievementCategoryLabel(selected)} · ${lines.length} 项 · 第 ${pageNo}/${lastPage} 页`
      : `成就分类 · ${lines.length} 类 · 第 ${pageNo}/${lastPage} 页`;
    const page = [header, ...lines.slice((pageNo - 1) * pageSize, pageNo * pageSize)];
    if (pageNo < lastPage) page.push("可在指令末尾追加第2页等页码。");
    if (result.stale) page.push("部分索引未更新，可发送 #图鉴状态 查看版本。");
    return page.join("\n");
  } catch {
    return missing;
  }
}

async function challengeQuery(argument: string): Promise<string> {
  const { game, query } = searchTerms(argument);
  if (!game) return "用法：#挑战图鉴 原神|星铁|绝区零 模式 [名称或记录 ID]";
  const [modeName = "", ...terms] = query.split(/\s+/u);
  const mode = findChallengeMode(game, modeName);
  if (!mode) {
    const names = challengeModes.filter((item) => item.game === game).map(({ name }) => name);
    return `${gameNames[game]}挑战图鉴：${names.join("、")}。请输入模式以查看记录。`;
  }
  const target = terms.join(" ");
  if (/^(?:当前|本期|当期|上期|下期|第\s*\d+\s*期)$/u.test(target)) {
    return "快照的记录 ID 与正式期号可能不同。请输入记录 ID 或名称，或只输入游戏与模式查看列表。";
  }

  try {
    const result = await catalog.read();
    const category = result.pages.find((page) => page.game === game && page.challengeMode?.id === mode.id);
    if (!category) return `快照中未收录${gameNames[game]}的${mode.name}资料。`;

    const pageMatch = /^第(\d+)页$/u.exec(target);
    if (!target || pageMatch) {
      const page = pageMatch ? Number(pageMatch[1]) : 1;
      const pageSize = 12;
      const lastPage = Math.ceil(category.entries.length / pageSize);
      if (!Number.isSafeInteger(page) || page < 1 || page > lastPage) return `请输入第 1 至 ${lastPage} 页。`;
      const entries = category.entries.slice((page - 1) * pageSize, page * pageSize);
      return [
        `${gameNames[game]} · ${mode.name} · 共 ${category.entries.length} 条 · 第 ${page}/${lastPage} 页`,
        ...entries.map(({ name, id }) => name === id ? `记录 ID ${id}` : `${name} · ID ${id}`),
        "输入记录 ID 或名称查看关卡资料，也可在模式后追加第2页等页码。",
        ...(result.stale ? ["部分索引未更新，可发送 #图鉴状态 查看版本。"] : []),
      ].join("\n");
    }

    const key = compareKey(target);
    const recordId = target.normalize("NFKC");
    const idMatch = category.entries.find(({ id }) => id === recordId);
    const matches = idMatch ? [idMatch] : category.entries.filter(({ name }) => key && compareKey(name) === key);
    if (!matches.length) return "未找到挑战记录，请核对完整名称或记录 ID。";
    if (matches.length > 1) {
      return [`${mode.name}有 ${matches.length} 条同名记录，请用 ID 查询。`,
        ...matches.slice(0, 12).map(({ name, id }) => `${name} · ID ${id}`),
        ...(matches.length > 12 ? ["更多 ID 可在模式列表中查看。"] : []),
      ].join("\n");
    }

    const [entry] = matches;
    if (!entry) return "未找到挑战记录。";
    const { window, sections } = await catalog.challengeFacts(entry, mode);
    const title = [gameNames[game], mode.name, entry.name !== entry.id ? entry.name : "", `记录 ID ${entry.id}`]
      .filter(Boolean).join(" · ");
    const lines = [title, `快照版本 ${entry.version}`];
    if (window) {
      const origin = window.from === "live" ? "快照记录的实装时间" : "导出时间（轮换待核对）";
      lines.push(`${origin} · ${window.begin} 至 ${window.end}`);
    } else {
      lines.push("该条目缺少已知的起止时间。");
    }
    if (!sections.length) lines.push("当前快照缺少可验证的关卡详情。");
    for (const section of sections) {
      const names = section.items.slice(0, 8);
      const end = section.items.length > names.length ? "等" : "";
      lines.push(`${section.label} · 共 ${section.count} 条${names.length ? ` · ${names.join("、")}${end}` : ""}`);
    }
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
    "#套装图鉴": (argument: string) => setsQuery(argument, "#套装图鉴"),
    "#圣遗物图鉴": (argument: string) => setsQuery(argument, "#圣遗物图鉴", "gi"),
    "#遗器图鉴": (argument: string) => setsQuery(argument, "#遗器图鉴", "hsr"),
    "#驱动盘图鉴": (argument: string) => setsQuery(argument, "#驱动盘图鉴", "zzz"),
    "#邦布图鉴": bangbooQuery,
    "#成就图鉴": achievementQuery,
    "#成就分类": achievementCategoryQuery,
    "#挑战图鉴": challengeQuery,
    async "#图鉴状态"(): Promise<string> {
      try {
        const result = await catalog.read();
        const lines = result.pages.map(({ game, name, version, entries, sampled, achievementCategories }) => {
          const count = achievementCategories
            ? `${achievementCategories.length} 类 · ${achievementCategories.reduce((total, category) => total + category.entries.length, 0)} 项`
            : `${entries.length} 个条目`;
          return `${gameNames[game]} · ${name} · ${version} · ${count}${sampled ? "（样例）" : ""}`;
        });
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
