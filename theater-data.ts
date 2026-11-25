import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { samachurlArtwork } from "./challenge-artwork.ts";
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
  [1, $t("theater-data.text_45daa9092e")], [2, $t("theater-data.text_de907d10df")], [3, $t("theater-data.text_4ea02714a1")], [4, $t("theater-data.text_5102bbdbe1")], [5, $t("theater-data.text_680ea5e43a")],
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
const numerals = ["", $t("theater-data.text_51a75f4634"), $t("theater-data.text_084b42f6e9"), $t("theater-data.text_a4c3313deb"), $t("theater-data.text_754a9d5828"), $t("theater-data.text_c9b87f516a"), $t("theater-data.text_de07b53838"), $t("theater-data.text_1b0542878c"), $t("theater-data.text_2c467d3673"), $t("theater-data.text_df897da6e0"), $t("theater-data.text_fc7edd399a")];

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

const octoberBosses = new Map([
  [6, { name: $t("theater-data.text_bef76149bd"), artwork: "gallery/gi/UI_MonsterIcon_Volkodlak_Greyhound_Furiosa.webp" }],
  [8, { name: $t("theater-data.text_2aeedc74a3"), artwork: "gallery/gi/UI_MonsterIcon_Chimera_Manticore.webp" }],
]);

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
  const { window } = readChallengeFacts(theaterMode, content);
  const anchoredLunar = difficulty === 5 && entry.name === entry.id &&
    (entry.version === "7.2" || entry.version === "7.2.52") && window?.from === "live";
  const octoberLunar = anchoredLunar && entry.id === "30" &&
    window.begin === "2026-10-01 04:00:00" && window.end === "2026-11-01 03:59:59";
  const novemberLunar = anchoredLunar && entry.id === "31" &&
    window.begin === "2026-11-01 04:00:00" && window.end === "2026-12-01 03:59:59";

  const actors = (values: readonly unknown[]) => Promise.all(values.flatMap((value) => {
    const row = object(value);
    const id = positiveInteger(row.id ?? row.avatar_id ?? row.value ?? value);
    if (!id) return [];
    return [lookup.character(String(id)).then((known) => ({
      id,
      name: known?.name ?? $t("theater-data.text_45cc49fe49", { "id": id }),
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
      : [{ name: $t("theater-data.text_57089b1164", { "id": id }) }];
  }));

  const readActs = (key: "room" | "hard_room") => Promise.all(numberRows(config[key]).map(async ([roomId, room], index): Promise<TheaterAct> => {
    const preview = room.monster_preview_list;
    const title = singleLine(room.title);
    const description = singleLine(room.desc);
    // The November live enemy preview omits this boss. The released battle menu shows Lv95.
    const samachurl = novemberLunar && key === "room" && roomId === 8 && room.monster_level === 94 &&
      title === "历经百战的丘丘萨满" && description.includes("美味汤锅") && Array.isArray(preview) && !preview.length;
    const level = samachurl ? 95 : positiveInteger(room.monster_level);
    const octoberBoss = octoberLunar && key === "room" && Array.isArray(preview) && !preview.length
      ? octoberBosses.get(roomId) : undefined;
    const supplement = samachurl ? { name: title, artwork: samachurlArtwork.path } : octoberBoss;
    const enemies = supplement?.name === title ? [supplement] :
      distinct(await Promise.all(list(preview).flatMap((value, position) => {
        const enemy = object(value);
        const id = positiveInteger(enemy.id);
        const sourceName = singleLine(enemy.name);
        if (!sourceName && !id) return [];
        const icon = artwork(`detail.difficulty_config.${difficulty}.${key}.${roomId}.monster_preview_list.${position}.icon`);
        const known = id ? lookup.enemy(String(id), sourceName) : Promise.resolve(undefined);
        return [known.then((entry) => ({
          id, name: sourceName || entry?.name || $t("theater-data.text_e741124190", { "id": id }),
          artwork: icon ?? entry?.artwork, description: effectText(enemy.desc) || entry?.description,
        }))];
      })));
    return {
      name: key === "room" ? $t("theater-data.text_9a41e92526", { "value1": numerals[roomId] ?? roomId }) : $t("theater-data.text_b8745abf83", { "value1": numerals[index + 1] ?? index + 1 }),
      subtitle: [level ? `Lv${level}` : "", title].filter(Boolean).join(" · "),
      description,
      enemies,
    };
  }));
  const [acts, hardActs] = await Promise.all([readActs("room"), readActs("hard_room")]);
  return {
    name: current ? $t("theater-data.text_c4a0399bc0") : entry.name === entry.id ? theaterMode.name : entry.name,
    version: entry.version,
    artwork: artwork(),
    window,
    difficulty: difficulties.get(difficulty)!,
    minLevel: positiveInteger(config.minimum_avatar_level),
    maxAct: positiveInteger(config.boss_max_room_number),
    elements: availableElements,
    groups: [
      { name: $t("theater-data.text_8bd1d453a7"), cards: opening },
      { name: $t("theater-data.text_175721fa68"), cards: invited },
      { name: $t("theater-data.text_8481f992ad"), cards: distinct(acts.flatMap((act) => act.enemies)).slice(0, 10) },
      { name: $t("theater-data.text_49b5f6c5a6"), cards: distinct(hardActs.flatMap((act) => act.enemies)).slice(0, 12) },
    ].filter(({ cards }) => cards.length),
    acts: [...acts, ...hardActs],
  };
}
