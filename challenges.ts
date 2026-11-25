import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import type { Game } from "./catalog.ts";
import { compareKey, effectText, label, object } from "./source-values.ts";

export const onslaughtMode = { game: "gi", id: "leyline", name: $t("challenges.text_c3354e0ec8"), aliases: ["幽境", "危战", "地脉异常", "幽境危战"] } as const;
export const theaterMode = { game: "gi", id: "rolecombat", name: $t("challenges.text_8cb870ae6a"), aliases: ["幻想真境", "幻想真境剧诗"] } as const;
export const abyssMode = { game: "gi", id: "tower", name: $t("challenges.text_82f72c6585"), aliases: ["深渊", "深境螺旋"] } as const;
export const apocalypseMode = { game: "hsr", id: "maze_boss", name: $t("challenges.text_8dae72d970"), aliases: ["末日", "末日幻影"] } as const;
export const fictionMode = { game: "hsr", id: "maze_extra", name: $t("challenges.text_d66b949b63"), aliases: ["虚构", "虚构叙事"] } as const;
export const chaosMode = { game: "hsr", id: "maze", name: $t("challenges.text_59977c7f79"), aliases: ["混沌", "忘却", "忘却之庭", "混沌回忆"] } as const;
export const shiyuMode = { game: "zzz", id: "shiyu", name: $t("challenges.text_f718dc4321"), aliases: ["防卫", "防卫战", "式舆", "式舆防卫", "式舆防卫战"] } as const;
export const deadlyAssaultMode = { game: "zzz", id: "boss", name: $t("challenges.text_4b7b8e83d9"), aliases: ["危局", "强袭", "强袭战", "危局强袭战"] } as const;
export const arbitrationMode = { game: "hsr", id: "maze_peak", name: $t("challenges.text_fdc6c58c58"), aliases: ["异相", "异相仲裁"] } as const;

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

const datedRotations = new Set<ChallengeMode["id"]>(["tower", "leyline", "rolecombat", "maze", "maze_extra", "maze_boss", "shiyu", "boss"]);

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

async function findAdjacentChallenge<Entry extends { readonly id: string }, Facts extends RotationFacts>(
  mode: ChallengeMode, direction: "previous" | "next", entries: readonly Entry[], readFacts: (entry: Entry) => Promise<Facts>, now: number,
) {
  const rows = await Promise.all(entries.map(async (entry) => {
    const facts = await readFacts(entry);
    return { entry, facts, times: rotationTimes(mode, facts) };
  }));
  const active = rows.filter(({ times }) => times && times.begin <= now && now < times.end);
  const [current] = active;
  if (active.length !== 1 || !current?.times || hasChallengeScheduleConflict(mode, current.entry.id, current.facts.window)) return;
  const boundary = direction === "previous" ? current.times.begin : current.times.end;
  const adjacent = rows.filter(({ times }) => (direction === "previous" ? times?.end : times?.begin) === boundary);
  const [match] = adjacent;
  if (adjacent.length !== 1 || !match?.times || hasChallengeScheduleConflict(mode, match.entry.id, match.facts.window)) return;
  const { begin, end } = match.times;
  if (rows.some((row) => row !== match && row.times && row.times.begin < end && begin < row.times.end)) return;
  return { current, adjacent: { entry: match.entry, facts: match.facts } };
}

export async function findNextShiyu<Entry extends { readonly id: string }, Facts extends RotationFacts>(
  entries: readonly Entry[], readFacts: (entry: Entry) => Promise<Facts>, now = Date.now(),
) {
  return (await findAdjacentChallenge(shiyuMode, "next", entries, readFacts, now))?.adjacent;
}

export async function findNextOnslaught<Entry extends { readonly id: string }, Facts extends RotationFacts>(
  entries: readonly Entry[], readFacts: (entry: Entry) => Promise<Facts>, now = Date.now(),
) {
  const scheduled = await findAdjacentChallenge(onslaughtMode, "next", entries, readFacts, now);
  if (scheduled) return scheduled.adjacent;
  const rotation = await findCurrentChallenge(onslaughtMode, entries, readFacts, now);
  if (!rotation || !/^5269[0-9]{3}$/u.test(rotation.entry.id)) return;
  // This source numbers successive Onslaught rounds in the 5269xxx series.
  const nextId = String(Number(rotation.entry.id) + 1);
  const matches = entries.filter(entry => entry.id === nextId);
  const [entry] = matches;
  if (matches.length !== 1 || !entry) return;
  const facts = await readFacts(entry);
  if (facts.rotationEligible && facts.window?.from === "export") return { entry, facts };
}

const announcedRotations = {
  // Star Rail 4.6 and 4.7. The source uses an exclusive end at the next minute.
  // https://hsr.hoyoverse.com/en-us/news/166468
  // https://www.hoyolab.com/article/47394097
  maze_extra: {
    current: { id: "2027", name: $t("challenges.text_22edd0035a"), begin: "2026-10-19 04:00:00", end: "2026-11-30 04:00:00" },
    next: { id: "2028", name: $t("challenges.text_021d012f08"), begin: "2026-11-30 04:00:00", end: "2027-01-11 04:00:00" },
  },
  maze: {
    current: { id: "1036", name: $t("challenges.text_be12270e62"), begin: "2026-11-02 04:00:00", end: "2026-12-14 04:00:00" },
    next: { id: "1037", name: $t("challenges.text_6fc1f71265"), begin: "2026-12-14 04:00:00", end: "2027-01-25 04:00:00" },
  },
  maze_boss: {
    current: { id: "3021", name: $t("challenges.text_ea18af671f"), begin: "2026-10-05 04:00:00", end: "2026-11-16 04:00:00" },
    next: { id: "3022", name: $t("challenges.text_64fa2949c6"), begin: "2026-11-16 04:00:00", end: "2026-12-28 04:00:00" },
  },
  // Genshin 7.1 and 7.2 with the monthly reset rule from the original announcement.
  // https://ys.mihoyo.com/main/news/detail/166392
  // https://ys.mihoyo.com/main/news/detail/167205
  // https://www.hoyolab.com/article/29513513
  rolecombat: {
    current: { id: "31", name: "31", begin: "2026-11-01 04:00:00", end: "2026-12-01 03:59:59" },
    next: { id: "32", name: "32", begin: "2026-12-01 04:00:00", end: "2027-01-01 03:59:59" },
  },
};

export async function findAnnouncedChallengeNext<Entry extends { readonly id: string; readonly name: string }, Facts extends RotationFacts>(
  mode: typeof apocalypseMode | typeof chaosMode | typeof fictionMode | typeof theaterMode,
  entries: readonly Entry[], readFacts: (entry: Entry) => Promise<Facts>, now = Date.now(),
) {
  const rotation = await findAdjacentChallenge(mode, "next", entries, readFacts, now);
  if (!rotation) return;
  const announcement = announcedRotations[mode.id];
  const pairs = [[rotation.current, announcement.current], [rotation.adjacent, announcement.next]] as const;
  if (pairs.every(([{ entry, facts: { window } }, { id, name, begin, end }]) =>
    entry.id === id && entry.name === name && window?.begin === begin && window.end === end)) return rotation.adjacent;
}

export async function findPreviousChallenge<Entry extends { readonly id: string }, Facts extends RotationFacts>(
  mode: typeof abyssMode | typeof apocalypseMode | typeof chaosMode | typeof deadlyAssaultMode |
    typeof fictionMode | typeof onslaughtMode | typeof shiyuMode | typeof theaterMode,
  entries: readonly Entry[],
  readFacts: (entry: Entry) => Promise<Facts>, now = Date.now(),
) {
  return (await findAdjacentChallenge(mode, "previous", entries, readFacts, now))?.adjacent;
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
      if (floors.length) sections.push({ label: $t("challenges.text_ce3b386bd7"), items: floors.map((id) => $t("challenges.text_e4539ff0bd", { "id": id })), count: floors.length });
      break;
    }
    case "rolecombat": {
      const count = Object.keys(object(detail.difficulty_config)).length;
      if (count) sections.push({ label: $t("challenges.text_d9733ee617"), items: [], count });
      break;
    }
    case "leyline": {
      const levels = Object.values(object(detail.level));
      const items = levels.flatMap((row) => {
        const level = object(row).monster_level;
        const name = typeof level === "number" ? onslaughtDifficulties.get(level) : undefined;
        return name ? [name] : [];
      });
      if (levels.length) sections.push({ label: $t("challenges.text_d9733ee617"), items, count: levels.length });
      break;
    }
    case "maze":
      sections.push(namedSection($t("challenges.text_0e9b00150c"), Array.isArray(value) ? value : []));
      break;
    case "maze_boss":
    case "maze_extra":
      sections.push(namedSection($t("challenges.text_0e9b00150c"), Array.isArray(detail.level) ? detail.level : []));
      break;
    case "maze_peak":
      sections.push(namedSection($t("challenges.text_0551caec03"), Array.isArray(detail.pre_level) ? detail.pre_level : []));
      if (Object.keys(object(detail.boss_level)).length) {
        sections.push(namedSection($t("challenges.text_38028918f7"), [detail.boss_level]));
      }
      break;
    case "shiyu":
      sections.push(namedSection($t("challenges.text_ecaa55b32c"), Object.values(object(detail.zone))));
      break;
    case "boss":
      for (const row of Array.isArray(detail.modes) ? detail.modes : []) {
        const { zone_type, zone } = object(row);
        const type = zone_type === 1001 ? $t("challenges.text_5629e20a86") : zone_type === 1002 ? $t("challenges.text_88d514ca0b") : $t("challenges.text_0e9b00150c");
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
