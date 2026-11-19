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
const command = new RegExp(`${glued.source}|${shortcut.source}`, "u");

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

interface ShortcutEvent {
  readonly msg: string;
  reply(value: string): unknown;
}

type PluginConstructor = new (options: { name: string; rule: { reg: RegExp; fnc: string }[] }) => { e?: ShortcutEvent };

export function traditionalAtlasApps(findReply: (query: string, game?: Game) => Promise<string | undefined>) {
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
          if (query) return this.send(event, query);
          const target = parseEquipmentShortcut(event.msg);
          if (!target) return false;
          return this.send(event, target.query, target.game);
        }

        async send(event: ShortcutEvent, query: string, game?: Game) {
          const reply = await findReply(query, game);
          if (reply === undefined) return false;
          await event.reply(reply);
        }
      };
    },
  };
}
