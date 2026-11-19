import type { AtlasEntry } from "./catalog.ts";
import { readChallengeFacts, theaterMode } from "./challenges.ts";
import { effectText, galleryArtwork, object } from "./source-values.ts";

interface TheaterCard {
  readonly id?: number;
  readonly name: string;
  readonly artwork?: string;
  readonly description?: string;
}

interface TheaterAct {
  readonly name: string;
  readonly subtitle: string;
  readonly description: string;
  readonly enemies: readonly TheaterCard[];
}

export interface TheaterDetails {
  readonly name: string;
  readonly version: string;
  readonly artwork?: string;
  readonly window: ReturnType<typeof readChallengeFacts>["window"];
  readonly difficulty: string;
  readonly minLevel?: number;
  readonly maxAct?: number;
  readonly elements: readonly TheaterCard[];
  readonly groups: readonly { name: string; cards: readonly TheaterCard[] }[];
  readonly acts: readonly TheaterAct[];
}

const difficulties = new Map([
  [1, "轻简"], [2, "普通"], [3, "困难"], [4, "卓越"], [5, "月谕"],
]);

// Compare the May and June notices to distinguish 草/冰, then the October list for 风.
// https://ys.mihoyo.com/main/news/detail/163470
// https://ys.mihoyo.com/main/news/detail/164263
// October/November and December also confirm which field holds the opening lineup.
// https://ys.mihoyo.com/main/news/detail/166392
// https://ys.mihoyo.com/main/news/detail/167205
const elements = new Map<number, readonly [string, string]>([
  [2, ["火", "Skill_E_PlayerFire_01"]], [3, ["水", "Skill_E_PlayerWater_01"]],
  [4, ["草", "Skill_E_PlayerGrass_01"]], [5, ["雷", "Skill_E_PlayerElectric_01"]],
  [6, ["冰", "UI_AnimalIcon_Wisp_Ice_01"]], [7, ["风", "Skill_E_PlayerWind_01"]],
  [8, ["岩", "Skill_E_PlayerRock_01"]],
]);
const numerals = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function numberRows(value: unknown) {
  return Object.entries(object(value))
    .filter(([key]) => /^[1-9]\d*$/u.test(key) && Number.isSafeInteger(Number(key)))
    .map(([key, row]) => [Number(key), object(row)] as const)
    .sort(([a], [b]) => a - b);
}

function distinct(cards: readonly TheaterCard[]): TheaterCard[] {
  const seen = new Set<string>();
  return cards.filter(({ id, name, artwork }) => {
    const key = JSON.stringify([id, name, artwork]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function list(primary: unknown, fallback: unknown = undefined): unknown[] {
  return Array.isArray(primary) ? primary : Array.isArray(fallback) ? fallback : [];
}

const singleLine = (value: unknown) => effectText(value).replace(/\s*\n\s*/gu, " ");

interface TheaterLookup {
  character: (id: string) => Promise<TheaterCard | undefined>;
  enemy: (id: string, name: string) => Promise<TheaterCard | undefined>;
}

export async function normalizeTheater(entry: AtlasEntry, content: Record<string, unknown>, images: unknown,
  lookup: TheaterLookup, current = false): Promise<TheaterDetails | undefined> {
  if (entry.game !== "gi") return;
  const { detail: rawDetail, list: rawList } = content;
  const detail = object(rawDetail);
  const summary = object(rawList);
  const selection = numberRows(detail.difficulty_config).reverse()
    .find(([id, details]) => difficulties.has(id) && numberRows(details.room).length);
  if (!selection) return;
  const [difficulty, config] = selection;
  const avatar = object(detail.avatar_config);
  const artwork = galleryArtwork(images, "gi");

  const actors = (values: readonly unknown[]) => Promise.all(values.flatMap((value) => {
    const row = object(value);
    const id = positiveInteger(row.id ?? row.avatar_id ?? row.value ?? value);
    if (!id) return [];
    return [lookup.character(String(id)).then((known) => ({
      name: known?.name ?? `角色 ID ${id}（待核对）`,
      artwork: known?.artwork,
      description: singleLine(row.desc),
    }))];
  }));
  const [opening, invited] = await Promise.all([
    actors(list(avatar.buff_avatar_list, summary.buff)),
    actors(list(avatar.invite_avatar_list, summary.invite)),
  ]);

  const availableElements = distinct(list(avatar.element_list, summary.element).flatMap((value) => {
    const id = positiveInteger(value);
    if (!id) return [];
    const element = elements.get(id);
    return element
      ? [{ name: element[0], artwork: `gallery/gi/${element[1]}.webp` }]
      : [{ name: `元素代码 ${id}（待核对）` }];
  }));

  const readActs = (key: "room" | "hard_room") => Promise.all(numberRows(config[key]).map(async ([roomId, room], index): Promise<TheaterAct> => {
    const level = positiveInteger(room.monster_level);
    return {
      name: key === "room" ? `第${numerals[roomId] ?? roomId}幕` : `圣牌${numerals[index + 1] ?? index + 1}`,
      subtitle: [level ? `Lv${level}` : "", singleLine(room.title)].filter(Boolean).join(" · "),
      description: singleLine(room.desc),
      enemies: distinct(await Promise.all(list(room.monster_preview_list).flatMap((value, position) => {
        const enemy = object(value);
        const id = positiveInteger(enemy.id);
        const sourceName = singleLine(enemy.name);
        if (!sourceName && !id) return [];
        const icon = artwork(`detail.difficulty_config.${difficulty}.${key}.${roomId}.monster_preview_list.${position}.icon`);
        const known = id ? lookup.enemy(String(id), sourceName) : Promise.resolve(undefined);
        return [known.then((entry) => ({
          id, name: sourceName || entry?.name || `敌人 ID ${id}（待核对）`,
          artwork: icon ?? entry?.artwork, description: effectText(enemy.desc) || entry?.description,
        }))];
      }))),
    };
  }));
  const [acts, hardActs] = await Promise.all([readActs("room"), readActs("hard_room")]);
  return {
    name: current ? "当期幻想真境剧诗" : entry.name === entry.id ? theaterMode.name : entry.name,
    version: entry.version,
    artwork: artwork(),
    window: readChallengeFacts(theaterMode, content).window,
    difficulty: difficulties.get(difficulty)!,
    minLevel: positiveInteger(config.minimum_avatar_level),
    maxAct: positiveInteger(config.boss_max_room_number),
    elements: availableElements,
    groups: [
      { name: "开幕角色", cards: opening },
      { name: "特邀角色", cards: invited },
      { name: "首领阵容", cards: distinct(acts.flatMap((act) => act.enemies)).slice(0, 10) },
      { name: "圣牌挑战", cards: distinct(hardActs.flatMap((act) => act.enemies)).slice(0, 12) },
    ].filter(({ cards }) => cards.length),
    acts: [...acts, ...hardActs],
  };
}
