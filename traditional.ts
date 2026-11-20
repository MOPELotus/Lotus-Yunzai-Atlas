import type { Game } from "./catalog.ts";

const prefixes: Readonly<Record<string, Game>> = {
  "#": "gi", "#原神": "gi", "#星铁": "hsr", "#星穹铁道": "hsr", "#崩坏星穹铁道": "hsr", "#崩铁": "hsr",
  "#绝区零": "zzz", "#绝区": "zzz", "*": "hsr", "%": "zzz", "％": "zzz",
};
const shortcut = /^[#*%％][^\r\n]+图鉴$/u;
const gamePrefix = /^(?:#崩坏星穹铁道|#星穹铁道|#绝区零|#绝区|#星铁|#崩铁|#原神|[#*%％])/u;
const reserved = /攻略|练度统计|(?:命座|星魂|影画|天赋)$/u;
const operations = /^#?(?:Lotus|lotus|荷花)?(?:图鉴(?:状态|帮助|更新|检查更新|全量更新|重置)|(?:更新|检查更新|全量更新|重置|清空)图鉴)$/u;
const glued = /^#?(?:Lotus|lotus|荷花)?图鉴(\S[^\r\n]*)$/u;
const roleShortcut = /^(?:[#*%％][^\r\n]+|[^#*%％\s][^\r\n]+)(?:命座|星魂|影画|天赋)(?:图鉴)?$/u;
const roleDetail = /^(.+?)(命座|星魂|影画|天赋)(?:图鉴)?$/u;
const command = new RegExp(`${glued.source}|${shortcut.source}|${roleShortcut.source}`, "u");
const datedAbyss = /^#(?:原神)?(\d{4})[./年-](\d{1,2})[./月-](\d{1,2})日?(本期|当期|上期)(?:深渊|深境螺旋)图鉴$/u;

export function parseDatedAbyssShortcut(message: string) {
  const match = datedAbyss.exec(message.trim());
  if (!match) return;
  const [, year, month, day, period] = match;
  const date = `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
  // Lotus-ReFactor's extractExplicitDate uses noon in the China server timezone.
  const at = Date.parse(`${date}T12:00:00+08:00`);
  const valid = Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === date;
  return { period: period === "上期" ? "上期" as const : "本期" as const, at: valid ? at : undefined };
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
  if (!query || reserved.test(query) || /^[0-9]+$/u.test(query.normalize("NFKC"))) return;
  const game = prefixes[prefix];
  if (game) return { game, query };
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
export type AtlasReply = AtlasNode | { readonly type: "forward"; readonly nodes: readonly AtlasNode[] };
type Lookup = "glued" | "shortcut" | "character";

interface ShortcutEvent {
  readonly msg: string;
  readonly forward?: (nodes: readonly AtlasNode[]) => Promise<boolean>;
  reply(value: AtlasNode): unknown;
}

type PluginConstructor = new (options: { name: string; rule: { reg: RegExp; fnc: string }[] }) => { e?: ShortcutEvent };

export function traditionalAtlasApps(
  findReply: (query: string, kind: Lookup, game?: Game) => Promise<AtlasReply | undefined>,
  findDatedAbyssReply: (period: "本期" | "上期", at: number) => Promise<AtlasReply>,
) {
  return {
    // The host installs the V3 base before it enumerates the exported apps.
    get AtlasTraditionalCommands() {
      const Base = (globalThis as typeof globalThis & { plugin?: PluginConstructor }).plugin;
      if (!Base) return;
      return class extends Base {
        constructor() {
          super({ name: "图鉴旧指令", rule: [{ reg: command, fnc: "lookup" }] });
        }

        async lookup(event: ShortcutEvent) {
          const query = parseGluedLookup(event.msg);
          if (query) return this.send(event, await findReply(query, "glued"));
          const role = parseRoleShortcut(event.msg);
          if (role) return this.send(event, await findReply(role.query, "character", role.game));
          const dated = parseDatedAbyssShortcut(event.msg);
          if (dated) return this.send(event, dated.at === undefined
            ? "日期无效，请输入有效日期，例如 #2026-11-16本期深渊图鉴。"
            : await findDatedAbyssReply(dated.period, dated.at));
          const target = parseEquipmentShortcut(event.msg);
          if (!target) return false;
          return this.send(event, await findReply(target.query, "shortcut", target.game));
        }

        async send(event: ShortcutEvent, reply: AtlasReply | undefined) {
          if (reply === undefined) return false;
          if (typeof reply === "string" || reply.type === "image") {
            await event.reply(reply);
            return;
          }
          if (event.forward) {
            try {
              if (await event.forward(reply.nodes)) return;
            } catch {
              await event.reply("合并转发结果未确认，请在聊天中核对。");
              return;
            }
          }
          for (const node of reply.nodes) await event.reply(node);
        }
      };
    },
  };
}
