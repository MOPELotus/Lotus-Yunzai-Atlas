import { readAtlasRoleSettings, type AtlasRoleSettings } from "./role-switches.ts";
import { defaultAtlasLocale, parseAtlasLocale } from "./locale.ts";
import { atlasBookReply } from "./book-reply.ts";
import { LegacyAtlasSourceConflict } from "./legacy-atlas-directory.ts";
import { AtlasSnapshotReset } from "./snapshot-pointer.ts";
import { characterGalleryName, starRailTrailblazerName } from "./role-data.ts";
import { fileURLToPath } from "node:url";
import { abyssMode, apocalypseMode, arbitrationMode, challengeModes, chaosMode, deadlyAssaultMode, fictionMode, findAnnouncedChallengeNext,
  findChallengeMode, findCurrentChallenge, findNextShiyu, findPreviousChallenge, hasChallengeRotation, hasChallengeScheduleConflict,
  onslaughtMode, shiyuMode, theaterMode, type ChallengeMode } from "./challenges.ts";
import { compareKey } from "./source-values.ts";
import { findAchievementCategories, findAchievements, type AchievementCategory } from "./achievements.ts";
import { createAtlasRuntimeCatalog, findBangboos, findSets, findCharacters, findEquipment, findTraditionalEntries,
  gameNames, type AtlasEntry, type Game, type TraditionalLookup } from "./catalog.ts";
import { invalidChallengeDate, parseExplicitAtlasChallenge, traditionalAtlasEvent,
  type AtlasDelivery, type AtlasImage, type AtlasReply, type RoleQueryView, type RoleSection } from "./traditional.ts";
import type { StarrailChallengeMode } from "./starrail-challenge-data.ts";
import { atlasMaintenanceAliases, createAtlasMaintenance } from "./maintenance.ts";
import { atlasHelp, atlasHelpAliases } from "./help.ts";
import { atlasStatus, atlasDataUnavailable as missing } from "./status.ts";
import { readZzzAliasRegistry, zzzRoleName } from "./zzz-aliases.ts";
import { defaultAtlasSearchLimit, parseAtlasSearchLimit } from "./search-limit.ts";

export { findAchievementCategories, findAchievements } from "./achievements.ts";
export { createAtlasCatalog, findBangboos, findSets, findCharacters, findEquipment, findMonsters } from "./catalog.ts";

const games = new Map<string, Game>([
  ["原神", "gi"], ["星铁", "hsr"], ["星穹铁道", "hsr"], ["崩坏星穹铁道", "hsr"], ["崩铁", "hsr"],
  ["绝区零", "zzz"], ["绝区", "zzz"],
]);
const atlasRoot = fileURLToPath(new URL("../../data/atlas/", import.meta.url));
type AtlasCatalog = ReturnType<typeof createAtlasRuntimeCatalog>;

function searchTerms(argument: string, fixedGame?: Game) {
  const words = argument.trim().split(/\s+/u);
  const statedGame = games.get(words[0] ?? "");
  if (statedGame) words.shift();
  return { game: fixedGame ?? statedGame, query: words.join(" "),
    mismatched: Boolean(fixedGame && statedGame && fixedGame !== statedGame) };
}

async function equipmentLine(catalog: AtlasCatalog, item: AtlasEntry): Promise<string> {
  const { category, rarity, scope } = await catalog.equipmentFacts(item);
  return [gameNames[item.game], category, item.name, rarity || "等级待核对",
    scope || "适用范围待核对", `ID ${item.id}`].join(" · ");
}

async function setLines(catalog: AtlasCatalog, item: AtlasEntry, showEffects: boolean): Promise<string> {
  const { category, effects } = await catalog.setFacts(item);
  const header = [gameNames[item.game], category, item.name, `ID ${item.id}`].join(" · ");
  if (!showEffects) return header;
  return [header, ...(effects.length ? effects.map(({ pieces, text }) =>
    `${pieces}件套 · ${text || "效果待核对"}`) : ["套装效果待核对"])].join("\n");
}

async function characterLine(catalog: AtlasCatalog, character: AtlasEntry, showCategory = false): Promise<string> {
  const rarity = await catalog.characterRarity(character);
  const rank = rarity || (character.game === "zzz" ? "等级待核对" : "");
  const traveler = character.game === "gi" && character.name === "旅行者" ? await catalog.roleDetails(character) : undefined;
  const name = starRailTrailblazerName(character) ?? traveler?.overview.name ?? character.name;
  return [gameNames[character.game], showCategory ? "角色" : "", name, rank, `ID ${character.id}`].filter(Boolean).join(" · ");
}

async function bangbooLine(catalog: AtlasCatalog, item: AtlasEntry): Promise<string> {
  return ["绝区零", "邦布", item.name, await catalog.bangbooRarity(item) || "等级待核对", `ID ${item.id}`].join(" · ");
}

async function equipmentQuery(catalog: AtlasCatalog, argument: string, command: string, limit: number, fixedGame?: Game, delivery?: AtlasDelivery): Promise<string | AtlasImage> {
  const { game, query, mismatched } = searchTerms(argument, fixedGame);
  if (mismatched && fixedGame) return `${command}用于查询${gameNames[fixedGame]}的装备。`;
  if (!query) return `用法：${command} ${fixedGame ? "" : "[原神|星铁|绝区零] "}名称或 ID`;
  try {
    const result = await catalog.read();
    const matches = findEquipment(result, query, game);
    if (!matches.length) return "未找到匹配的武器、光锥或音擎。";
    if (matches.length === 1) {
      const image = await weaponCard(catalog, matches[0]!, delivery);
      if (image) return image;
    }
    const lines = await Promise.all(matches.slice(0, limit).map(item => equipmentLine(catalog, item)));
    if (matches.length > lines.length) lines.push("结果较多，请补充游戏名或更完整的名称。");
    if (result.stale) lines.push("部分索引未更新，可发送 #图鉴状态 查看版本。");
    return lines.join("\n");
  } catch {
    return missing;
  }
}

async function setsQuery(catalog: AtlasCatalog, argument: string, command: string, limit: number, fixedGame?: Game, delivery?: AtlasDelivery): Promise<AtlasReply> {
  const { game, query, mismatched } = searchTerms(argument, fixedGame);
  if (mismatched && fixedGame) return `${command}用于查询${gameNames[fixedGame]}的套装。`;
  if (!query) return `用法：${command} ${fixedGame ? "" : "[原神|星铁|绝区零] "}套装名或 ID`;
  try {
    const result = await catalog.read();
    const matches = findSets(result, query, game);
    if (!matches.length) return "未找到匹配的套装。";
    if (matches.length === 1) {
      const book = await setBook(catalog, matches[0]!, delivery);
      if (book) return book;
    }
    const lines = await Promise.all(matches.slice(0, limit).map((item) => setLines(catalog, item, matches.length === 1)));
    if (matches.length > lines.length) lines.push("结果较多，请补充游戏名或更完整的套装名。");
    if (result.stale) lines.push("部分索引未更新，可发送 #图鉴状态 查看版本。");
    return lines.join("\n");
  } catch {
    return missing;
  }
}

async function bangbooQuery(catalog: AtlasCatalog, argument: string, limit: number, delivery?: AtlasDelivery): Promise<AtlasReply> {
  const { query, mismatched } = searchTerms(argument, "zzz");
  if (mismatched) return "#邦布图鉴用于查询绝区零的邦布。";
  if (!query) return "用法：#邦布图鉴 名称或 ID";
  try {
    const result = await catalog.read();
    const matches = findBangboos(result, query);
    if (!matches.length) return "未找到匹配的邦布。";
    if (matches.length === 1) {
      const book = await bangbooBook(catalog, matches[0]!, delivery);
      if (book) return book;
    }
    const lines = await Promise.all(matches.slice(0, limit).map(item => bangbooLine(catalog, item)));
    if (matches.length > lines.length) lines.push("结果较多，请补充更完整的邦布名。");
    if (result.stale) lines.push("部分索引未更新，可发送 #图鉴状态 查看版本。");
    return lines.join("\n");
  } catch {
    return missing;
  }
}

async function characterBook(catalog: AtlasCatalog, entry: AtlasEntry, roster: readonly AtlasEntry[], delivery?: AtlasDelivery,
  section?: RoleSection, qFace = true): Promise<AtlasReply> {
  const role = await catalog.roleDetails(entry);
  const part = entry.game === "zzz" ? undefined : section;
  const title = part === "skills" ? (entry.game === "gi" ? "天赋" : "行迹") :
    part === "ranks" ? (entry.game === "gi" ? "命座" : "星魂") : undefined;
  const noData = () => title ? `${role?.overview.name ?? entry.name}暂无${title}资料。` : characterLine(catalog, entry, true);
  if (!role) return noData();
  try {
    const { renderRoleBook } = await import("./role-render.ts");
    const galleryName = characterGalleryName(entry, roster, role.overview.name);
    return await atlasBookReply(role.overview.name, scale => renderRoleBook(role, {
      scale, inlineImageByteLimit: delivery?.inlineImageByteLimit, assetRoot: catalog.assetRoot(entry), galleryName, qFace,
    }, part), delivery, !part, title) ?? noData();
  } catch {
    if (title) return `${role.overview.name}的${title}图片暂不可用。`;
    return `${await characterLine(catalog, entry, true)}\n图鉴图片暂不可用。`;
  }
}

async function characterPhoto(catalog: AtlasCatalog, entry: AtlasEntry, roster: readonly AtlasEntry[], delivery?: AtlasDelivery): Promise<AtlasReply> {
  const role = await catalog.roleDetails(entry);
  if (!role) return "暂无图片";
  const { readRolePhoto } = await import("./role-render.ts");
  const photo = await readRolePhoto(role, {
    assetRoot: catalog.assetRoot(entry),
    galleryName: characterGalleryName(entry, roster, role.overview.name),
    inlineImageByteLimit: delivery?.inlineImageByteLimit,
  });
  return photo ? { type: "image", file: photo } : "暂无图片";
}

async function weaponCard(catalog: AtlasCatalog, entry: AtlasEntry, delivery?: AtlasDelivery): Promise<AtlasImage | undefined> {
  const details = await catalog.weaponDetails(entry);
  if (!details) return;
  try {
    const { renderWeapon } = await import("./role-render.ts");
    const { png } = await renderWeapon(details, { inlineImageByteLimit: delivery?.inlineImageByteLimit, assetRoot: catalog.assetRoot(entry) });
    return { type: "image", file: png };
  } catch {
    return undefined;
  }
}

async function setBook(catalog: AtlasCatalog, entry: AtlasEntry, delivery?: AtlasDelivery): Promise<AtlasReply | undefined> {
  const set = await catalog.setDetails(entry);
  if (!set) return;
  try {
    const { renderSet } = await import("./role-render.ts");
    return await atlasBookReply(set.name, scale => renderSet(set, {
      scale, inlineImageByteLimit: delivery?.inlineImageByteLimit, assetRoot: catalog.assetRoot(entry),
    }), delivery);
  } catch {
    return undefined;
  }
}

async function bangbooBook(catalog: AtlasCatalog, entry: AtlasEntry, delivery?: AtlasDelivery): Promise<AtlasReply | undefined> {
  const bangboo = await catalog.bangbooDetails(entry);
  if (!bangboo) return;
  try {
    const { renderBangboo } = await import("./role-render.ts");
    return await atlasBookReply(bangboo.name, scale => renderBangboo(bangboo, {
      scale, inlineImageByteLimit: delivery?.inlineImageByteLimit, assetRoot: catalog.assetRoot(entry),
    }), delivery);
  } catch {
    return undefined;
  }
}

function monsterLine(entry: AtlasEntry): string {
  return [gameNames[entry.game], "敌人", entry.name, `ID ${entry.id}`].join(" · ");
}

function challengeTitle(entry: AtlasEntry, mode: ChallengeMode): string {
  return [gameNames[entry.game], mode.name, entry.name !== entry.id ? entry.name : "", `记录 ID ${entry.id}`].filter(Boolean).join(" · ");
}

async function challengeDetails(catalog: AtlasCatalog, entry: AtlasEntry, mode: ChallengeMode, current: boolean,
  facts?: Awaited<ReturnType<AtlasCatalog["challengeFacts"]>>, forecast = false): Promise<string[]> {
  const { window, sections } = facts ?? await catalog.challengeFacts(entry, mode);
  const lines = [challengeTitle(entry, mode), `快照版本 ${entry.version}`];
  if (current) lines.push("当前轮换 · 中国服（UTC+8）");
  if (window) {
    const origin = forecast ? "快照预计（下期预览）"
      : hasChallengeScheduleConflict(mode, entry.id, window) ? "快照时间（与实装公告冲突，待核对）"
      : window.from === "live" ? "快照记录的实装时间" : "导出时间（轮换待核对）";
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
  return lines;
}

async function onslaughtCard(catalog: AtlasCatalog, entry: AtlasEntry, delivery?: AtlasDelivery): Promise<AtlasImage | undefined> {
  const onslaught = await catalog.onslaughtDetails(entry);
  if (!onslaught) return;
  try {
    const { renderOnslaught } = await import("./role-render.ts");
    const { png } = await renderOnslaught(onslaught, { inlineImageByteLimit: delivery?.inlineImageByteLimit, assetRoot: catalog.assetRoot(entry) });
    return { type: "image", file: png };
  } catch {
    return undefined;
  }
}

async function starrailChallengeCard(catalog: AtlasCatalog, entry: AtlasEntry, result: Awaited<ReturnType<AtlasCatalog["read"]>>,
  mode: StarrailChallengeMode, period?: "current" | "next", delivery?: AtlasDelivery): Promise<AtlasReply | undefined> {
  const challenge = await catalog.starrailChallengeDetails(entry, result, mode, period === "current");
  if (!challenge) return;
  try {
    const { renderStarrailChallenge } = await import("./role-render.ts");
    const card = period === "next" ? { ...challenge, name: `下期${challenge.name}（预览）` } : challenge;
    return await atlasBookReply(card.name, scale => renderStarrailChallenge(card, {
      scale, inlineImageByteLimit: delivery?.inlineImageByteLimit, assetRoot: catalog.assetRoot(entry),
    }), delivery);
  } catch {
    return undefined;
  }
}

async function monsterReply(catalog: AtlasCatalog, entry: AtlasEntry, delivery?: AtlasDelivery): Promise<string | AtlasImage> {
  const title = monsterLine(entry);
  const monster = await catalog.monsterDetails(entry);
  if (!monster) return `${title}\n当前快照缺少已核对的敌人简介。`;
  try {
    const { renderMonster } = await import("./role-render.ts");
    const { png } = await renderMonster(monster, { inlineImageByteLimit: delivery?.inlineImageByteLimit, assetRoot: catalog.assetRoot(entry) });
    return { type: "image", file: png };
  } catch {
    return [title, monster.description,
      ...(monster.sections ?? []).map(({ title, content }) => `${title}：${content}`)].join("\n");
  }
}

async function genshinCardReply(catalog: AtlasCatalog, entry: AtlasEntry, delivery?: AtlasDelivery): Promise<AtlasReply> {
  const title = `原神 · 七圣召唤 · ${entry.name} · ID ${entry.id}`;
  const card = await catalog.genshinCardDetails(entry);
  if (!card) return title;
  try {
    const { renderGenshinCard } = await import("./role-render.ts");
    const { png } = await renderGenshinCard(card, { inlineImageByteLimit: delivery?.inlineImageByteLimit, assetRoot: catalog.assetRoot(entry) });
    return { type: "image", file: png };
  } catch {
    return [title, card.description, ...card.skills.map(({ name, description }) => `${name}：${description}`)].filter(Boolean).join("\n");
  }
}

async function localZzzAlias(catalogue: Awaited<ReturnType<AtlasCatalog["read"]>>, query: string) {
  const registry = await readZzzAliasRegistry(Bun.env.LOTUS_ZZZ_LEGACY_RESOURCES_DIR, globalThis.redis).catch(() => undefined);
  const candidates = registry?.aliases.get(zzzRoleName(query));
  if (candidates?.length !== 1) return;
  const alias = candidates[0]!;
  const entries = findTraditionalEntries(catalogue, alias.role, "zzz", "character");
  const matches = entries.filter(({ entry }) => !alias.id || entry.id === alias.id);
  const match = matches[0];
  if (matches.length === 1 && match) return { ...match, kind: "character" as const };
}

async function lookupNotice(query: string, message: string, game: Game | undefined, delivery?: AtlasDelivery): Promise<string | AtlasImage> {
  const title = query.replace(/\s+/gu, " ").trim().slice(0, 96).toWellFormed();
  try {
    const { renderLookupNotice } = await import("./role-render.ts");
    const { png } = await renderLookupNotice(title || "图鉴查询", message, game, {
      inlineImageByteLimit: delivery?.inlineImageByteLimit,
    });
    return { type: "image", file: png };
  } catch {
    return message;
  }
}

function roleQueriesEnabled(settings: AtlasRoleSettings, game: Game, section?: RoleQueryView) {
  if (game === "zzz") return true;
  if (section === "photo") return settings.role_photo;
  if (section === "skills" || section === "ranks") return settings.role_talent;
  return settings.role_wiki;
}

async function traditionalQuery(
  catalog: AtlasCatalog, roleSettings: AtlasRoleSettings,
  query: string, limit: number, game?: Game, mode: TraditionalLookup | "shortcut" | "legacy-character" = "search",
  delivery?: AtlasDelivery, section?: RoleQueryView,
): Promise<AtlasReply | undefined> {
  const explicit = mode === "search" || mode === "shortcut" || mode === "character";
  try {
    const quickLookup = mode === "bare" || mode === "weapon";
    let result = quickLookup ? await catalog.readForEquipmentShortcut() : await catalog.read();
    const lookup = mode === "legacy-character" ? "character" : mode === "character" ? "character-search" :
      mode === "shortcut" ? "search" : mode;
    let matches: ReturnType<typeof findTraditionalEntries>[number][] = findTraditionalEntries(result, query, game, lookup);
    if ((!game || game === "zzz") && !quickLookup && mode !== "equipment" && matches.every(({ score }) => score < 2.5)) {
      const alias = await localZzzAlias(result, query);
      if (alias) matches = [alias];
    }
    if (section === "photo") matches = matches.filter(({ entry }) => entry.game !== "zzz");
    if (mode === "legacy-character" && matches.length !== 1) return;
    if ((mode === "search" || mode === "name") && matches.every(({ score }) => score < 3)) {
      const category = await traditionalAchievementCategory(catalog, query, result, game, delivery);
      if (category) return category;
    }
    if (!matches.length && mode === "shortcut" && game === "hsr") {
      const key = query.normalize("NFKC").toLowerCase();
      const entries = result.pages.find(({ challengeMode }) => challengeMode?.id === arbitrationMode.id)?.entries ?? [];
      const named = entries.filter(({ name, id }) => name !== id && name.normalize("NFKC").toLowerCase() === key);
      if (named.length > 1) return ["异相仲裁存在同名资料，请使用 #挑战图鉴 星铁 异相仲裁 记录 ID。",
        ...named.map(({ name, id }) => `${name} · ID ${id}`)].join("\n");
      const [entry] = named;
      if (entry) {
        const image = await starrailChallengeCard(catalog, entry, result, arbitrationMode, undefined, delivery);
        if (image) return image;
        return (await challengeDetails(catalog, entry, arbitrationMode, false)).join("\n");
      }
    }
    if (!matches.length && explicit) {
      const roleOnly = mode === "character";
      if (roleOnly && findTraditionalEntries(result, query, game, "name").length) return;
      matches = await catalog.findInDetails(result, query, game, roleOnly, limit);
    }
    if (!matches.length && mode === "search") {
      const files = await catalog.findUnindexedLegacy(result, query, game);
      if (files) {
        matches = findTraditionalEntries(files, query, game, "search");
        if (matches.length) result = { ...result, pages: [...result.pages, ...files.pages] };
      }
    }
    const available = matches.filter(({ kind, entry }) => kind !== "character" || roleQueriesEnabled(roleSettings, entry.game, section));
    if (matches.length && !available.length) return mode === "search" ? "所查询的角色资料已关闭。" : undefined;
    matches = available;
    if (!matches.length) {
      if (!explicit) return;
      const message = mode === "character" ? "未找到匹配的角色资料。" :
        "未找到匹配的图鉴资料。请补充游戏名或更完整的名称。";
      return lookupNotice(query, result.stale ? `${message}\n部分索引未更新，可发送 #图鉴状态 查看版本。` : message, game, delivery);
    }
    const first = matches[0]!;
    if (quickLookup && first.kind === "equipment") {
      if (matches.length !== 1) return;
      return await weaponCard(catalog, first.entry, delivery) ?? equipmentLine(catalog, first.entry);
    }
    if (matches.length === 1 && first.kind === "character") {
      const { entry } = first;
      const roster = result.pages.find(page => page.kind === "character" && page.game === entry.game)?.entries ?? [];
      return section === "photo" ? characterPhoto(catalog, entry, roster, delivery) :
        characterBook(catalog, entry, roster, delivery, section, roleSettings.role_q_face);
    }
    if (matches.length === 1 && first.kind === "equipment") {
      const image = await weaponCard(catalog, first.entry, delivery);
      if (image) return image;
    }
    if (matches.length === 1 && first.kind === "set") {
      const book = await setBook(catalog, first.entry, delivery);
      if (book) return book;
    }
    if (matches.length === 1 && first.kind === "bangboo") {
      const book = await bangbooBook(catalog, first.entry, delivery);
      if (book) return book;
    }
    if (matches.length === 1 && first.kind === "gcg") return genshinCardReply(catalog, first.entry, delivery);
    if (matches.length === 1 && first.kind === "reference") {
      const details = await catalog.referenceDetails(first.entry, result);
      if (!details) return lookupNotice(query, "图鉴条目详情不可用，请检查当前图鉴导出。", game, delivery);
      try {
        const { renderReference } = await import("./role-render.ts");
        const book = await atlasBookReply(details.name, scale => renderReference(details, {
          scale, inlineImageByteLimit: delivery?.inlineImageByteLimit, assetRoot: catalog.assetRoot(first.entry),
        }), delivery);
        if (book) return book;
      } catch {
        // The source fields remain useful even when this gateway cannot deliver the image.
      }
      return [`${gameNames[details.game]} · ${details.category} · ${details.name}`, details.intro,
        ...details.sections.map(({ title, content }) => `${title}：${content}`)].filter(Boolean).join("\n");
    }
    if (matches.length === 1 && first.kind === "monster") {
      const reply = await monsterReply(catalog, first.entry, delivery);
      return typeof reply === "string" && result.stale ? `${reply}\n部分索引未更新，可发送 #图鉴状态 查看版本。` : reply;
    }
    if (matches.length === 1 && first.kind === "challenge") {
      const image = await onslaughtCard(catalog, first.entry, delivery);
      if (image) return image;
      const lines = await challengeDetails(catalog, first.entry, onslaughtMode, false);
      if (result.stale) lines.push("部分索引未更新，可发送 #图鉴状态 查看版本。");
      return lines.join("\n");
    }
    const lines = await Promise.all(matches.slice(0, limit).map(({ kind, entry }) => {
      switch (kind) {
        case "equipment": return equipmentLine(catalog, entry);
        case "set": return setLines(catalog, entry, matches.length === 1);
        case "character": return characterLine(catalog, entry, true);
        case "bangboo": return bangbooLine(catalog, entry);
        case "monster": return monsterLine(entry);
        case "gcg": return `原神 · 七圣召唤 · ${entry.name} · ID ${entry.id}`;
        case "challenge": return challengeTitle(entry, onslaughtMode);
        case "reference": return `${gameNames[entry.game]} · ${entry.name} · ID ${entry.id}`;
      }
    }));
    if (matches.length > lines.length) lines.push("结果较多，请补充游戏名或更完整的名称。");
    if (result.stale) lines.push("部分索引未更新，可发送 #图鉴状态 查看版本。");
    return lines.join("\n");
  } catch (error) {
    if (!explicit) return;
    const message = error instanceof LegacyAtlasSourceConflict || error instanceof AtlasSnapshotReset ? error.message : missing;
    return lookupNotice(query, message, game, delivery);
  }
}

function achievementCategoryLabel(category: AchievementCategory): string {
  return [gameNames[category.game], category.parent, category.name].filter(Boolean).join(" · ");
}

async function traditionalAchievementCategory(catalog: AtlasCatalog, query: string, result: Awaited<ReturnType<AtlasCatalog["read"]>>, game?: Game, delivery?: AtlasDelivery) {
  const key = compareKey(query);
  if (!key) return;
  const categories = result.pages.flatMap((page) => page.achievementCategories ?? []);
  const matches = findAchievementCategories(categories, query, game)
    .filter((category) => category.game !== "zzz" && compareKey(category.name) === key);
  if (matches.length > 1) return matches.map(achievementCategoryLabel).join("\n");
  const [category] = matches;
  if (!category) return;
  const source = result.pages.find((page) => page.achievementCategories?.includes(category))?.entries
    .find(({ id }) => id === category.id);
  if (source) {
    try {
      const { renderAchievementCategory } = await import("./role-render.ts");
      const artwork = await catalog.achievementCategoryArtwork(source);
      const { png } = await renderAchievementCategory(category, artwork, { inlineImageByteLimit: delivery?.inlineImageByteLimit, assetRoot: catalog.assetRoot(source) });
      return { type: "image" as const, file: png };
    } catch {
      // The category stays available as text if the card renderer is unavailable.
    }
  }
  return `${achievementCategoryLabel(category)} · ${category.entries.length} 项`;
}

async function achievementQuery(catalog: AtlasCatalog, argument: string, limit: number): Promise<string> {
  const { game, query } = searchTerms(argument);
  if (!query) return "用法：#成就图鉴 [原神|星铁|绝区零] 成就名或 ID";
  try {
    const result = await catalog.read();
    const categories = result.pages.flatMap((page) => page.achievementCategories ?? []);
    const matches = findAchievements(categories, query, game);
    if (!matches.length) return "未找到匹配的成就。";

    const lines = matches.slice(0, limit).map(({ category, entry }) => {
      const title = `${achievementCategoryLabel(category)} · ${entry.name} · ID ${entry.id}`;
      return matches.length <= limit && entry.description ? `${title}\n${entry.description}` : title;
    });
    if (matches.length > lines.length) lines.push(`共 ${matches.length} 条，请补充游戏名或更完整的成就名。`);
    if (result.stale) lines.push("部分索引未更新，可发送 #图鉴状态 查看版本。");
    return lines.join("\n");
  } catch {
    return missing;
  }
}

async function achievementCategoryQuery(catalog: AtlasCatalog, argument: string): Promise<string> {
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

async function challengeQuery(catalog: AtlasCatalog, argument: string, at?: number, delivery?: AtlasDelivery): Promise<AtlasReply> {
  const { game, query } = searchTerms(argument);
  if (!game) return "用法：#挑战图鉴 原神|星铁|绝区零 模式 [名称或记录 ID]";
  const [modeName = "", ...terms] = query.split(/\s+/u);
  const mode = findChallengeMode(game, modeName);
  if (!mode) {
    const names = challengeModes.filter((item) => item.game === game).map(({ name }) => name);
    return `${gameNames[game]}挑战图鉴：${names.join("、")}。请输入模式以查看记录。`;
  }
  const target = terms.join(" ");
  const currentRequested = /^(?:当前|本期|当期)$/u.test(target);
  const displayCurrent = currentRequested && at === undefined;
  const previous = target === "上期" &&
    (mode.id === abyssMode.id || mode.id === apocalypseMode.id || mode.id === chaosMode.id ||
      mode.id === deadlyAssaultMode.id || mode.id === fictionMode.id || mode.id === onslaughtMode.id ||
      mode.id === shiyuMode.id || mode.id === theaterMode.id);
  const forecast = target === "下期" &&
    (mode.id === apocalypseMode.id || mode.id === chaosMode.id || mode.id === fictionMode.id ||
      mode.id === shiyuMode.id || mode.id === theaterMode.id);
  const relative = previous || forecast;
  const unverifiedRotation = `${mode.name}${currentRequested ? "本期" : target}轮换时间待核对。请输入记录 ID 或名称查看资料。`;
  if (currentRequested && !hasChallengeRotation(mode)) return unverifiedRotation;
  if (!relative && /^(?:上期|下期)$/u.test(target)) return unverifiedRotation;
  if (/^第\s*\d+\s*期$/u.test(target)) {
    return "快照的记录 ID 与正式期号可能不同。请输入记录 ID 或名称，或只输入游戏与模式查看列表。";
  }

  try {
    const result = await catalog.read();
    const category = result.pages.find((page) => page.game === game && page.challengeMode?.id === mode.id);
    if (!category) return currentRequested || relative ? unverifiedRotation : `快照中未收录${gameNames[game]}的${mode.name}资料。`;

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

    let entry: AtlasEntry | undefined;
    let facts: Awaited<ReturnType<AtlasCatalog["challengeFacts"]>> | undefined;
    if (currentRequested || relative) {
      if (result.stale || category.sampled) return unverifiedRotation;
      const readFacts = (item: AtlasEntry) => catalog.challengeFacts(item, mode);
      const matched = forecast
        ? await (mode.id === shiyuMode.id
          ? findNextShiyu(category.entries, readFacts, at) : findAnnouncedChallengeNext(mode, category.entries, readFacts, at))
        : previous ? await findPreviousChallenge(mode, category.entries, readFacts, at)
        : await findCurrentChallenge(mode, category.entries, readFacts, at);
      if (!matched) return unverifiedRotation;
      ({ entry, facts } = matched);
    } else {
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
      [entry] = matches;
    }

    if (!entry) return "未找到挑战记录。";
    if (mode.id === onslaughtMode.id) {
      const image = await onslaughtCard(catalog, entry, delivery);
      if (image) return image;
    }
    if (mode.id === theaterMode.id) {
      const theater = await catalog.theaterDetails(entry, result, displayCurrent);
      if (theater) {
        try {
          const { renderTheater } = await import("./role-render.ts");
          const card = forecast ? { ...theater, name: "下期幻想真境剧诗（预览）" } : theater;
          const { png } = await renderTheater(card, { inlineImageByteLimit: delivery?.inlineImageByteLimit, assetRoot: catalog.assetRoot(entry) });
          return { type: "image", file: png };
        } catch {
          // The verified challenge summary remains usable without rendering.
        }
      }
    }
    if (mode.id === abyssMode.id) {
      const abyss = await catalog.abyssDetails(entry, result, displayCurrent);
      if (abyss) {
        try {
          const { renderAbyss } = await import("./role-render.ts");
          const { png } = await renderAbyss(abyss, { inlineImageByteLimit: delivery?.inlineImageByteLimit, assetRoot: catalog.assetRoot(entry) });
          return { type: "image", file: png };
        } catch {
          // The verified challenge summary remains usable without rendering.
        }
      }
    }
    if (mode.id === apocalypseMode.id || mode.id === arbitrationMode.id || mode.id === fictionMode.id || mode.id === chaosMode.id) {
      const image = await starrailChallengeCard(catalog, entry, result, mode, forecast ? "next" : displayCurrent ? "current" : undefined, delivery);
      if (image) return image;
    }
    if (mode.id === shiyuMode.id) {
      const shiyu = await catalog.shiyuDetails(entry, result, forecast ? "next" : displayCurrent ? "current" : undefined);
      if (shiyu) {
        try {
          const { renderShiyu } = await import("./role-render.ts");
          const reply = await atlasBookReply(shiyu.name, scale => renderShiyu(shiyu, {
            scale, inlineImageByteLimit: delivery?.inlineImageByteLimit, assetRoot: catalog.assetRoot(entry),
          }), delivery);
          if (reply) return reply;
        } catch {
          // The verified challenge summary remains usable without rendering.
        }
      }
    }
    if (mode.id === deadlyAssaultMode.id) {
      const deadlyAssault = await catalog.deadlyAssaultDetails(entry, result, displayCurrent);
      if (deadlyAssault) {
        try {
          const { renderDeadlyAssault } = await import("./role-render.ts");
          const { png } = await renderDeadlyAssault(deadlyAssault, { inlineImageByteLimit: delivery?.inlineImageByteLimit, assetRoot: catalog.assetRoot(entry) });
          return { type: "image", file: png };
        } catch {
          // The verified challenge summary remains usable without rendering.
        }
      }
    }
    const lines = await challengeDetails(catalog, entry, mode, displayCurrent, facts, forecast);
    if (result.stale) lines.push("部分索引未更新，可发送 #图鉴状态 查看版本。");
    return lines.join("\n");
  } catch {
    return missing;
  }
}

function createTraditionalQueries(catalog: AtlasCatalog, limit: number, roleSettings: AtlasRoleSettings) {
  return traditionalAtlasEvent((argument, kind, game, delivery, section) => {
    if (kind !== "glued") return traditionalQuery(catalog, roleSettings, argument, limit, game, kind, delivery, section);
    return explicitAtlasQuery(catalog, argument, limit, roleSettings, delivery);
  }, (mode, period, at, delivery) => challengeQuery(catalog, `${gameNames[mode.game]} ${mode.name} ${period}`, at, delivery));
}

async function explicitAtlasQuery(catalog: AtlasCatalog, argument: string, limit: number, roleSettings: AtlasRoleSettings, delivery?: AtlasDelivery) {
  const { game, query } = searchTerms(argument);
  if (!query) return "用法：#图鉴 [原神|星铁|绝区零] 名称或 ID";
  const challenge = parseExplicitAtlasChallenge(query, game);
  if (challenge?.invalidDate) return invalidChallengeDate;
  if (challenge) return challengeQuery(catalog, `${gameNames[challenge.mode.game]} ${challenge.mode.name} ${challenge.period}`, challenge.at, delivery);
  return await traditionalQuery(catalog, roleSettings, query, limit, game, "search", delivery) ?? missing;
}

function challengeCommand(catalog: AtlasCatalog, query: string) {
  return (_argument: string, delivery?: AtlasDelivery) => challengeQuery(catalog, query, undefined, delivery);
}

function searchCommands(catalog: AtlasCatalog, limit: number, roleSettings: AtlasRoleSettings) {
  return {
    "#图鉴": (argument: string, delivery?: AtlasDelivery) => explicitAtlasQuery(catalog, argument, limit, roleSettings, delivery),
    "#武器图鉴": (argument: string, delivery?: AtlasDelivery) => equipmentQuery(catalog, argument, "#武器图鉴", limit, undefined, delivery),
    "#光锥图鉴": (argument: string, delivery?: AtlasDelivery) => equipmentQuery(catalog, argument, "#光锥图鉴", limit, "hsr", delivery),
    "#音擎图鉴": (argument: string, delivery?: AtlasDelivery) => equipmentQuery(catalog, argument, "#音擎图鉴", limit, "zzz", delivery),
    "#套装图鉴": (argument: string, delivery?: AtlasDelivery) => setsQuery(catalog, argument, "#套装图鉴", limit, undefined, delivery),
    "#圣遗物图鉴": (argument: string, delivery?: AtlasDelivery) => setsQuery(catalog, argument, "#圣遗物图鉴", limit, "gi", delivery),
    "#遗器图鉴": (argument: string, delivery?: AtlasDelivery) => setsQuery(catalog, argument, "#遗器图鉴", limit, "hsr", delivery),
    "#驱动盘图鉴": (argument: string, delivery?: AtlasDelivery) => setsQuery(catalog, argument, "#驱动盘图鉴", limit, "zzz", delivery),
    "#邦布图鉴": (argument: string, delivery?: AtlasDelivery) => bangbooQuery(catalog, argument, limit, delivery),
    "#成就图鉴": (argument: string) => achievementQuery(catalog, argument, limit),
    async "#角色图鉴"(argument: string): Promise<string> {
      const { game, query } = searchTerms(argument);
      if (!query) return "用法：#角色图鉴 [原神|星铁|绝区零] 名称或 ID";

      try {
        const result = await catalog.read();
        let matches = findCharacters(result, query, game);
        if ((!game || game === "zzz") &&
            findTraditionalEntries(result, query, game, "character").every(({ score }) => score < 2.5)) {
          const alias = await localZzzAlias(result, query);
          if (alias) matches = [alias.entry];
        }
        if (!matches.length) return "未找到匹配的角色。";
        matches = matches.filter(character => roleQueriesEnabled(roleSettings, character.game));
        if (!matches.length) return "所查询的角色资料已关闭。";
        const lines = await Promise.all(matches.slice(0, limit).map((character) => characterLine(catalog, character)));
        if (matches.length > lines.length) lines.push("结果较多，请补充游戏名或更完整的角色名。");
        if (result.stale) lines.push("部分索引未更新，可发送 #图鉴状态 查看版本。");
        return lines.join("\n");
      } catch {
        return missing;
      }
    },
  };
}

function atlasDefinitions(catalog: AtlasCatalog) {
  return {
    aliases: {
      ...atlasMaintenanceAliases,
      ...atlasHelpAliases,
      "图鉴": "#图鉴",
      "图鉴状态": "#图鉴状态",
      "#星铁本期末日幻影图鉴": "#星铁本期末日图鉴",
      "#星铁上期末日幻影图鉴": "#星铁上期末日图鉴",
      "#星铁下期末日幻影图鉴": "#星铁下期末日图鉴",
      "#星铁本期虚构叙事图鉴": "#星铁本期虚构图鉴",
      "#星铁上期虚构叙事图鉴": "#星铁上期虚构图鉴",
      "#星铁下期虚构叙事图鉴": "#星铁下期虚构图鉴",
      "#星铁本期混沌回忆图鉴": "#星铁本期混沌图鉴",
      "#星铁本期忘却图鉴": "#星铁本期混沌图鉴",
      "#星铁本期忘却之庭图鉴": "#星铁本期混沌图鉴",
      "#星铁上期混沌回忆图鉴": "#星铁上期混沌图鉴",
      "#星铁上期忘却图鉴": "#星铁上期混沌图鉴",
      "#星铁上期忘却之庭图鉴": "#星铁上期混沌图鉴",
      "#星铁下期混沌回忆图鉴": "#星铁下期混沌图鉴",
      "#星铁下期忘却图鉴": "#星铁下期混沌图鉴",
      "#星铁下期忘却之庭图鉴": "#星铁下期混沌图鉴",
      "#星铁异相仲裁图鉴": "#星铁异相图鉴",
      "#星铁本期异相仲裁图鉴": "#星铁本期异相图鉴",
      "#星铁当期异相图鉴": "#星铁本期异相图鉴",
      "#星铁当期异相仲裁图鉴": "#星铁本期异相图鉴",
      "#星铁上期异相仲裁图鉴": "#星铁上期异相图鉴",
      "#星铁下期异相仲裁图鉴": "#星铁下期异相图鉴",
      "#星铁下期异相": "#星铁下期异相图鉴",
      "#星铁下期异相仲裁": "#星铁下期异相图鉴",
      "#绝区零本期防卫图鉴": "#绝区零本期防卫战图鉴",
      "#绝区零本期式舆图鉴": "#绝区零本期防卫战图鉴",
      "#绝区零本期式舆防卫图鉴": "#绝区零本期防卫战图鉴",
      "#绝区零本期式舆防卫战图鉴": "#绝区零本期防卫战图鉴",
      "#绝区零上期防卫图鉴": "#绝区零上期防卫战图鉴",
      "#绝区零上期式舆图鉴": "#绝区零上期防卫战图鉴",
      "#绝区零上期式舆防卫图鉴": "#绝区零上期防卫战图鉴",
      "#绝区零上期式舆防卫战图鉴": "#绝区零上期防卫战图鉴",
      "#绝区零下期防卫图鉴": "#绝区零下期防卫战图鉴",
      "#绝区零下期式舆图鉴": "#绝区零下期防卫战图鉴",
      "#绝区零下期式舆防卫图鉴": "#绝区零下期防卫战图鉴",
      "#绝区零下期式舆防卫战图鉴": "#绝区零下期防卫战图鉴",
      "#绝区零本期危局强袭战图鉴": "#绝区零本期危局图鉴",
      "#绝区零本期强袭图鉴": "#绝区零本期危局图鉴",
      "#绝区零本期强袭战图鉴": "#绝区零本期危局图鉴",
      "#绝区零上期危局强袭战图鉴": "#绝区零上期危局图鉴",
      "#绝区零上期强袭图鉴": "#绝区零上期危局图鉴",
      "#绝区零上期强袭战图鉴": "#绝区零上期危局图鉴",
    },
    commands: {
      "#成就分类": (argument: string) => achievementCategoryQuery(catalog, argument),
      "#挑战图鉴": (argument: string, delivery?: AtlasDelivery) => challengeQuery(catalog, argument, undefined, delivery),
      "#图鉴帮助": atlasHelp,
      "#本期幻想图鉴": challengeCommand(catalog, "原神 幻想真境剧诗 本期"),
      "#本期幻想真境剧诗图鉴": challengeCommand(catalog, "原神 幻想真境剧诗 本期"),
      "#本期剧诗图鉴": challengeCommand(catalog, "原神 幻想真境剧诗 本期"),
      "#上期幻想图鉴": challengeCommand(catalog, "原神 幻想真境剧诗 上期"),
      "#上期幻想真境剧诗图鉴": challengeCommand(catalog, "原神 幻想真境剧诗 上期"),
      "#上期剧诗图鉴": challengeCommand(catalog, "原神 幻想真境剧诗 上期"),
      "#下期幻想图鉴": challengeCommand(catalog, "原神 幻想真境剧诗 下期"),
      "#下期幻想真境剧诗图鉴": challengeCommand(catalog, "原神 幻想真境剧诗 下期"),
      "#下期剧诗图鉴": challengeCommand(catalog, "原神 幻想真境剧诗 下期"),
      "#本期深渊图鉴": challengeCommand(catalog, "原神 深境螺旋 本期"),
      "#本期深境螺旋图鉴": challengeCommand(catalog, "原神 深境螺旋 本期"),
      "#上期深渊图鉴": challengeCommand(catalog, "原神 深境螺旋 上期"),
      "#上期深境螺旋图鉴": challengeCommand(catalog, "原神 深境螺旋 上期"),
      "#星铁本期末日图鉴": challengeCommand(catalog, "星铁 末日幻影 本期"),
      "#星铁上期末日图鉴": challengeCommand(catalog, "星铁 末日幻影 上期"),
      "#星铁下期末日图鉴": challengeCommand(catalog, "星铁 末日幻影 下期"),
      "#星铁本期虚构图鉴": challengeCommand(catalog, "星铁 虚构叙事 本期"),
      "#星铁上期虚构图鉴": challengeCommand(catalog, "星铁 虚构叙事 上期"),
      "#星铁下期虚构图鉴": challengeCommand(catalog, "星铁 虚构叙事 下期"),
      "#星铁本期混沌图鉴": challengeCommand(catalog, "星铁 混沌回忆 本期"),
      "#星铁上期混沌图鉴": challengeCommand(catalog, "星铁 混沌回忆 上期"),
      "#星铁下期混沌图鉴": challengeCommand(catalog, "星铁 混沌回忆 下期"),
      "#星铁异相图鉴": challengeCommand(catalog, "星铁 异相仲裁"),
      "#星铁本期异相图鉴": challengeCommand(catalog, "星铁 异相仲裁 本期"),
      "#星铁上期异相图鉴": challengeCommand(catalog, "星铁 异相仲裁 上期"),
      "#星铁下期异相图鉴": challengeCommand(catalog, "星铁 异相仲裁 下期"),
      "#绝区零本期防卫战图鉴": challengeCommand(catalog, "绝区零 式舆防卫战 本期"),
      "#绝区零上期防卫战图鉴": challengeCommand(catalog, "绝区零 式舆防卫战 上期"),
      "#绝区零下期防卫战图鉴": challengeCommand(catalog, "绝区零 式舆防卫战 下期"),
      "#绝区零本期危局图鉴": challengeCommand(catalog, "绝区零 危局强袭战 本期"),
      "#绝区零上期危局图鉴": challengeCommand(catalog, "绝区零 危局强袭战 上期"),
      "#图鉴状态": (_argument: string, delivery?: AtlasDelivery) => atlasStatus(catalog, delivery),
    },
  };
}

export function createModule({ signal, atlasUpdateConfig }: { readonly signal?: AbortSignal; readonly atlasUpdateConfig?: unknown } = {}) {
  const { commands, atlasSchedule } = createAtlasMaintenance(atlasRoot, {
    signal, updateConfig: atlasUpdateConfig, dataOverride: Bun.env.LOTUS_ATLAS_DATA_DIR,
  });
  const configured = atlasUpdateConfig as { readonly max_results?: unknown; readonly locale?: unknown } | undefined;
  const locale = parseAtlasLocale(configured?.locale) ?? defaultAtlasLocale;
  const catalog = createAtlasRuntimeCatalog(atlasRoot, Bun.env.LOTUS_ATLAS_DATA_DIR, locale);
  const atlas = atlasDefinitions(catalog);
  const limit = parseAtlasSearchLimit(configured?.max_results) ?? defaultAtlasSearchLimit;
  const roles = readAtlasRoleSettings(configured);
  return { ...atlas, commands: { ...atlas.commands, ...searchCommands(catalog, limit, roles), ...commands }, atlasSchedule,
    nativeEvents: [createTraditionalQueries(catalog, limit, roles)] };
}

export default createModule();
