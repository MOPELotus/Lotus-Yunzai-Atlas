import { sendBatchedImageForward, type BatchedImageForward } from "@lotus-yunzai/skia/forward-images";
import type { Game } from "./catalog.ts";
import { challengeModes, theaterMode, type ChallengeMode } from "./challenges.ts";

const prefixes: Readonly<Record<string, Game>> = {
  "#": "gi", "#原神": "gi", "#星铁": "hsr", "#星穹铁道": "hsr", "#崩坏星穹铁道": "hsr", "#崩铁": "hsr",
  "#绝区零": "zzz", "#绝区": "zzz", "*": "hsr", "%": "zzz", "％": "zzz",
};
const shortcut = /^[#*%％][^\r\n]+图鉴$/u;
const bareName = /^[#*%％][^\r\n]{2,128}$/u;
const gamePrefix = /^(?:#崩坏星穹铁道|#星穹铁道|#绝区零|#绝区|#星铁|#崩铁|#原神|[#*%％])/u;
const reserved = /攻略|练度统计|(?:命座|星魂|影画|天赋)$/u;
const reservedBare = /^(?:扫码登录|米哈游登录|锅巴登录|登录|刷新cookie|绑定设备|体力|全部体力|多体力|更新抽卡记录|刷新抽卡记录|全部记录|角色记录|武器记录|常驻记录|新手记录|抽卡记录|更新面板|帮助|菜单|签到|注册自动签到|远程|spawn|上传|下载|测试|最强|极限)|(?:面板|面版)(?:\d{1,3})?$|(?:面板|面版).*?[换变改]|(?:排名|排行|排行榜)$/iu;
const genericShortcut = /^(?:原神|星铁|崩铁|星穹铁道|绝区零|角色|武器|圣遗物|光锥|遗器|遗器套装|音擎|驱动盘|邦布|敌人|物品|材料|卡牌|七圣召唤)$/u;
const operations = /^#?(?:图鉴(?:状态|帮助|更新|检查更新|全量更新|重置)|(?:更新|检查更新|全量更新|重置|清空)图鉴)$/u;
const glued = /^#?图鉴(\S[^\r\n]*)$/u;
const roleShortcut = /^(?:[#*%％][^\r\n]+|[^#*%％\s][^\r\n]+)(?:命座|星魂|影画|天赋)(?:图鉴)?$/u;
const roleDetail = /^(.+?)(命座|星魂|影画|天赋)(?:图鉴)?$/u;
const command = new RegExp(`${glued.source}|${shortcut.source}|${roleShortcut.source}|${bareName.source}`, "u");
const challengePeriod = /^(?:(\d{4})[./年-](\d{1,2})[./月-](\d{1,2})日?)?(本期|当期|上期|下期)([^\r\n]+?)(图鉴)?$/u;
type ChallengePeriod = "本期" | "上期" | "下期";

function shortcutChallengeMode(game: Game, title: string) {
  return challengeModes.find((mode) => game === mode.game &&
    (mode.name === title || mode.aliases.some((name) => name === title) ||
      (mode === theaterMode && (title === "幻想" || title === "剧诗"))));
}

export function parseChallengeShortcut(message: string) {
  const input = message.trim();
  const prefix = gamePrefix.exec(input)?.[0];
  if (!prefix) return;
  const match = challengePeriod.exec(input.slice(prefix.length).trim());
  if (!match) return;
  const [, year, month, day, selector, title, explicitSuffix] = match;
  // Undated personal battle records use the same current/previous selectors.
  if (!year && !explicitSuffix && selector !== "下期") return;
  const game = prefixes[prefix];
  const mode = game && title ? shortcutChallengeMode(game, title) : undefined;
  if (!mode) return;
  const period: ChallengePeriod = selector === "上期" || selector === "下期" ? selector : "本期";
  if (!year) return { mode, period, at: undefined, invalidDate: false };
  const date = `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
  // The original date selector used noon in the China server timezone.
  const at = Date.parse(`${date}T12:00:00+08:00`);
  const valid = Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === date;
  return { mode, period, at: valid ? at : undefined, invalidDate: !valid };
}

export function parseGluedLookup(message: string): string | undefined {
  const input = message.trim();
  if (operations.test(input)) return;
  const query = glued.exec(input)?.[1];
  if (query && !reserved.test(query)) return query;
}

export function parseEquipmentShortcut(message: string): { game: Game; query: string } | undefined {
  const input = message.trim();
  if (!shortcut.test(input) || operations.test(input)) return;
  const prefix = gamePrefix.exec(input)?.[0];
  if (!prefix) return;
  const query = input.slice(prefix.length, -"图鉴".length).trim();
  const key = query.normalize("NFKC").replace(/\s+/gu, "");
  if (!query || reserved.test(query) || reservedBare.test(key) || genericShortcut.test(key) || /^[0-9]$/u.test(key)) return;
  const game = prefixes[prefix];
  if (game) return { game, query };
}

export function parseBareNameShortcut(message: string): { game: Game; query: string } | undefined {
  const input = message.trim();
  if (!bareName.test(input) || operations.test(input) || shortcut.test(input)) return;
  const prefix = gamePrefix.exec(input)?.[0];
  if (!prefix) return;
  const game = prefixes[prefix];
  const query = input.slice(prefix.length).trim();
  if (!game || query.length < 2 || reserved.test(query) || reservedBare.test(query) || genericShortcut.test(query) ||
      /^[0-9]+$/u.test(query.normalize("NFKC"))) return;
  if (shortcutChallengeMode(game, query.replace(/^(?:本期|当期|上期|往期|最新)/u, ""))) return;
  return { game, query };
}

export function parseRoleShortcut(message: string): { game?: Game; query: string } | undefined {
  const input = message.trim();
  const prefix = gamePrefix.exec(input)?.[0];
  const result = roleDetail.exec(input.slice(prefix?.length ?? 0));
  const query = result?.[1]?.trim();
  const suffix = result?.[2];
  if (!query || (!prefix && query.length < 2) || query === "角色" || reserved.test(query)) return;
  const game = prefix ? prefixes[prefix] : undefined;
  if (suffix === "天赋") return game ? { game, query } : { query };
  const suffixGame = suffix === "命座" ? "gi" : suffix === "星魂" ? "hsr" : "zzz";
  if (!game || game === suffixGame) return { game: suffixGame, query };
}

export type AtlasImage = { readonly type: "image"; readonly file: Uint8Array };
type AtlasNode = string | AtlasImage;
export type AtlasReply = AtlasNode | { readonly type: "forward"; readonly nodes: readonly AtlasNode[] } | BatchedImageForward;
type Lookup = "glued" | "shortcut" | "bare" | "character";

export interface AtlasDelivery {
  readonly inlineImageByteLimit?: number;
}

interface ShortcutEvent extends AtlasDelivery {
  readonly msg: string;
  readonly forward?: (nodes: readonly AtlasNode[]) => Promise<boolean>;
  reply(value: AtlasNode): unknown;
}

async function send(event: ShortcutEvent, reply: AtlasReply | undefined): Promise<boolean> {
  if (reply === undefined) return false;
  if (typeof reply === "string" || reply.type === "image") {
    await event.reply(reply);
    return true;
  }
  if (reply.type === "forward-image-batches") {
    const notice = await sendBatchedImageForward(reply, event.forward?.bind(event));
    if (notice) await event.reply(notice);
    return true;
  }
  if (event.forward) {
    try {
      if (await event.forward(reply.nodes)) return true;
    } catch {
      await event.reply("合并转发结果未确认，请在聊天中核对。");
      return true;
    }
  }
  for (const node of reply.nodes) await event.reply(node);
  return true;
}

export function traditionalAtlasEvent(
  findReply: (query: string, kind: Lookup, game?: Game, delivery?: AtlasDelivery) => Promise<AtlasReply | undefined>,
  findChallengeReply: (mode: ChallengeMode, period: ChallengePeriod, at?: number, delivery?: AtlasDelivery) => Promise<AtlasReply>,
) {
  return {
    name: "图鉴旧指令",
    event: "message",
    priority: 5000,
    rule: {
      pattern: command,
      async run(event: ShortcutEvent) {
        const delivery = { inlineImageByteLimit: event.inlineImageByteLimit };
        const query = parseGluedLookup(event.msg);
        if (query) return send(event, await findReply(query, "glued", undefined, delivery));
        const role = parseRoleShortcut(event.msg);
        if (role) return send(event, await findReply(role.query, "character", role.game, delivery));
        const challenge = parseChallengeShortcut(event.msg);
        if (challenge) return send(event, challenge.invalidDate
          ? "日期无效，请输入有效日期，支持 YYYY-MM-DD 或 YYYY年M月D日。"
          : await findChallengeReply(challenge.mode, challenge.period, challenge.at, delivery));
        const target = parseEquipmentShortcut(event.msg);
        if (target) return send(event, await findReply(target.query, "shortcut", target.game, delivery));
        const bare = parseBareNameShortcut(event.msg);
        return bare ? send(event, await findReply(bare.query, "bare", bare.game, delivery)) : false;
      },
    },
  };
}
