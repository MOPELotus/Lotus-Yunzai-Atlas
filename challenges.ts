import type { Game } from "./catalog.ts";
import { compareKey, effectText, label, object } from "./source-values.ts";

export const onslaughtMode = { game: "gi", id: "leyline", name: "幽境危战", aliases: ["幽境", "危战", "地脉异常"] } as const;
export const theaterMode = { game: "gi", id: "rolecombat", name: "幻想真境剧诗", aliases: ["幻想真境"] } as const;
export const abyssMode = { game: "gi", id: "tower", name: "深境螺旋", aliases: ["深渊"] } as const;
export const apocalypseMode = { game: "hsr", id: "maze_boss", name: "末日幻影", aliases: ["末日"] } as const;
export const fictionMode = { game: "hsr", id: "maze_extra", name: "虚构叙事", aliases: ["虚构"] } as const;
export const chaosMode = { game: "hsr", id: "maze", name: "混沌回忆", aliases: ["混沌", "忘却", "忘却之庭"] } as const;
export const shiyuMode = { game: "zzz", id: "shiyu", name: "式舆防卫战", aliases: ["防卫", "防卫战", "式舆", "式舆防卫"] } as const;
export const deadlyAssaultMode = { game: "zzz", id: "boss", name: "危局强袭战", aliases: ["危局", "强袭", "强袭战"] } as const;
export const arbitrationMode = { game: "hsr", id: "maze_peak", name: "异相仲裁", aliases: ["异相"] } as const;

export const challengeModes = [
  abyssMode,
  theaterMode,
  onslaughtMode,
  chaosMode,
  apocalypseMode,
  fictionMode,
  arbitrationMode,
  shiyuMode,
  deadlyAssaultMode,
] as const satisfies readonly { game: Game; id: string; name: string; aliases: readonly string[] }[];

export type ChallengeMode = typeof challengeModes[number];

export function findChallengeMode(game: Game, query: string): ChallengeMode | undefined {
  const key = compareKey(query);
  return challengeModes.find((mode) => mode.game === game &&
    [mode.name, mode.id, ...mode.aliases].some((name) => compareKey(name) === key));
}

interface ChallengeWindow {
  readonly begin: string;
  readonly end: string;
  readonly from: "live" | "export";
}

const datedRotations = new Set<ChallengeMode["id"]>(["tower", "rolecombat", "maze", "maze_extra", "maze_boss", "shiyu", "boss"]);

export function hasChallengeScheduleConflict(mode: ChallengeMode, id: string, window: ChallengeWindow | undefined) {
  // The official 7.2 notice places this blessing in the December 16 rotation.
  // https://ys.mihoyo.com/main/news/detail/167205
  return mode.id === "tower" && id === "126" && window?.from === "live" && window.begin === "2027-01-16 04:00:00";
}

export function hasChallengeRotation(mode: ChallengeMode): boolean {
  return datedRotations.has(mode.id);
}

interface RotationFacts {
  readonly window: ChallengeWindow | undefined;
  readonly rotationEligible: boolean;
}

function rotationTimes(mode: ChallengeMode, facts: RotationFacts) {
  const { window, rotationEligible } = facts;
  const lastSecondIncluded = mode.game !== "hsr";
  if (!rotationEligible || window?.from !== "live" || (lastSecondIncluded && !window.end.endsWith(":59"))) return;
  return {
    begin: Date.parse(window.begin.replace(" ", "T") + "+08:00"),
    end: Date.parse(window.end.replace(" ", "T") + "+08:00") + (lastSecondIncluded ? 1_000 : 0),
  };
}

export async function findCurrentChallenge<Entry extends { readonly id: string }, Facts extends RotationFacts>(
  mode: ChallengeMode, entries: readonly Entry[], readFacts: (entry: Entry) => Promise<Facts>, now = Date.now(),
): Promise<{ entry: Entry; facts: Facts } | undefined> {
  if (!hasChallengeRotation(mode) || !Number.isFinite(now)) return;
  let current: { entry: Entry; facts: Facts } | undefined;
  for (const entry of entries) {
    const facts = await readFacts(entry);
    const times = rotationTimes(mode, facts);
    if (!times || !(times.begin <= now && now < times.end)) continue;
    if (hasChallengeScheduleConflict(mode, entry.id, facts.window)) return;
    if (current) return;
    current = { entry, facts };
  }
  return current;
}

export async function findNextShiyu<Entry extends { readonly id: string }, Facts extends RotationFacts>(
  entries: readonly Entry[], readFacts: (entry: Entry) => Promise<Facts>, now = Date.now(),
): Promise<{ entry: Entry; facts: Facts } | undefined> {
  const rows = await Promise.all(entries.map(async (entry) => {
    const facts = await readFacts(entry);
    return { entry, facts, times: rotationTimes(shiyuMode, facts) };
  }));
  const active = rows.filter(({ times }) => times && times.begin <= now && now < times.end);
  const [current] = active;
  if (active.length !== 1 || !current?.times) return;
  const currentEnd = current.times.end;
  const adjacent = rows.filter(({ times }) => times?.begin === currentEnd);
  const [next] = adjacent;
  if (adjacent.length !== 1 || !next?.times) return;
  const { begin, end } = next.times;
  if (rows.some((row) => row !== next && row.times && row.times.begin < end && begin < row.times.end)) return;
  return { entry: next.entry, facts: next.facts };
}

function validDate(value: unknown): string {
  const date = label(value);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(date) || date < "2020-01-01") return "";
  const iso = date.replace(" ", "T") + "Z";
  const time = Date.parse(iso);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== iso.slice(0, 19)) return "";
  return date;
}

function sourceWindow(list: Record<string, unknown>): ChallengeWindow | undefined {
  const liveBegin = validDate(list.live_begin);
  const liveEnd = validDate(list.live_end);
  if (liveBegin && liveEnd > liveBegin) return { begin: liveBegin, end: liveEnd, from: "live" };

  const begin = validDate(list.begin);
  const end = validDate(list.end);
  if (begin && end > begin) return { begin, end, from: "export" };
}

interface ChallengeSection {
  readonly label: string;
  readonly items: readonly string[];
  readonly count: number;
}

const onslaughtDifficulties = new Map([[39, "N1"], [69, "N2"], [89, "N3"], [99, "N4"], [104, "N5"], [109, "N6"]]);

function namedSection(label: string, values: readonly unknown[]): ChallengeSection | undefined {
  if (!values.length) return;
  return {
    label,
    count: values.length,
    items: values.flatMap((row) => {
      const { name } = object(row);
      const text = effectText(name);
      return text ? [text] : [];
    }),
  };
}

function detailSections(mode: ChallengeMode, value: unknown): ChallengeSection[] {
  const detail = object(value);
  const sections: (ChallengeSection | undefined)[] = [];
  switch (mode.id) {
    case "tower": {
      const floors = Object.keys(object(detail.floor)).filter((id) => /^[1-9]\d*$/u.test(id));
      if (floors.length) sections.push({ label: "楼层", items: floors.map((id) => `第${id}层`), count: floors.length });
      break;
    }
    case "rolecombat": {
      const count = Object.keys(object(detail.difficulty_config)).length;
      if (count) sections.push({ label: "难度配置", items: [], count });
      break;
    }
    case "leyline": {
      const levels = Object.values(object(detail.level));
      const items = levels.flatMap((row) => {
        const level = object(row).monster_level;
        const name = typeof level === "number" ? onslaughtDifficulties.get(level) : undefined;
        return name ? [name] : [];
      });
      if (levels.length) sections.push({ label: "难度配置", items, count: levels.length });
      break;
    }
    case "maze":
      sections.push(namedSection("来源关卡", Array.isArray(value) ? value : []));
      break;
    case "maze_boss":
    case "maze_extra":
      sections.push(namedSection("来源关卡", Array.isArray(detail.level) ? detail.level : []));
      break;
    case "maze_peak":
      sections.push(namedSection("骑士", Array.isArray(detail.pre_level) ? detail.pre_level : []));
      if (Object.keys(object(detail.boss_level)).length) {
        sections.push(namedSection("王棋", [detail.boss_level]));
      }
      break;
    case "shiyu":
      sections.push(namedSection("防线与房间", Object.values(object(detail.zone))));
      break;
    case "boss":
      for (const row of Array.isArray(detail.modes) ? detail.modes : []) {
        const { zone_type, zone } = object(row);
        const type = zone_type === 1001 ? "试炼" : zone_type === 1002 ? "绝境" : "来源关卡";
        sections.push(namedSection(type, Object.values(object(zone))));
      }
      break;
  }
  return sections.filter((section) => section !== undefined);
}

export function readChallengeFacts(mode: ChallengeMode, content: Record<string, unknown>) {
  const list = object(content.list);
  return {
    window: sourceWindow(list),
    rotationEligible: mode.id !== "shiyu" || (list.sort === 1 && list.zh === "剧变节点"),
    sections: detailSections(mode, content.detail),
  };
}
