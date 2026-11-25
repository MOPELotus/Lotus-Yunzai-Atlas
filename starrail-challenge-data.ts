import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import type { AtlasEntry } from "./catalog.ts";
import { apocalypseMode, arbitrationMode, chaosMode, fictionMode, readChallengeFacts } from "./challenges.ts";
import { effectText, galleryArtwork, object } from "./source-values.ts";

interface StarrailEffect {
  readonly name: string;
  readonly description: string;
}

interface StarrailEnemy {
  readonly name: string;
  readonly artwork?: string;
  readonly description?: string;
}

interface StarrailSide {
  readonly name: string;
  readonly weaknesses: readonly string[];
  readonly enemies: readonly (StarrailEnemy & { readonly level?: number })[];
}

type StarrailEnemyLookup = (id: string) => Promise<StarrailEnemy | undefined>;
export type StarrailChallengeMode = typeof apocalypseMode | typeof arbitrationMode | typeof chaosMode | typeof fictionMode;

export interface StarrailChallengeDetails {
  readonly name: string;
  readonly artwork?: string;
  readonly version: string;
  readonly window: ReturnType<typeof readChallengeFacts>["window"];
  readonly effects: readonly StarrailEffect[];
  readonly optional: readonly StarrailEffect[];
  readonly rooms: readonly {
    readonly name: string;
    readonly description?: string;
    readonly goals: readonly string[];
    readonly optional?: readonly StarrailEffect[];
    readonly sides: readonly StarrailSide[];
  }[];
}

const elements = new Map([
  ["Physical", $t("starrail-challenge-data.text_a454f17872")], ["Fire", $t("starrail-challenge-data.text_d4cfe8c82c")], ["Ice", $t("starrail-challenge-data.text_ce1b850700")], ["Thunder", $t("starrail-challenge-data.text_5de1b913e7")],
  ["Wind", $t("starrail-challenge-data.text_be65bd5518")], ["Quantum", $t("starrail-challenge-data.text_14ed0de6a1")], ["Imaginary", $t("starrail-challenge-data.text_8908281fc3")],
]);

function rows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function gameText(value: unknown, parameters: unknown) {
  return effectText(value, Array.isArray(parameters) ? parameters : [parameters], true);
}

function effect(value: unknown): StarrailEffect {
  const { name, desc, param } = object(value);
  return { name: effectText(name), description: gameText(desc, param) };
}

function goalText(value: unknown, reportMissing: boolean) {
  const { name, param } = object(value);
  const text = gameText(name, param);
  if (text || !reportMissing || typeof name !== "string") return text;
  return effectText(name.replace(/#\d+(?:\[[a-z0-9]+\])?%?/giu, "（数值待核对）"));
}

async function readSide(name: string, stageList: unknown, damageTypes: unknown, enemy: StarrailEnemyLookup): Promise<StarrailSide> {
  const weaknesses = rows(damageTypes).flatMap((value) => {
    if (typeof value !== "string") return [];
    return [elements.get(value) ?? $t("starrail-challenge-data.text_baddef9767", { "value": value })];
  });
  const units = new Map<number, number | undefined>();
  for (const value of rows(stageList)) {
    const stage = object(value);
    const level = positiveInteger(stage.level);
    for (const wave of rows(stage.monster_list)) {
      for (const [slot, value] of Object.entries(object(wave))) {
        const id = positiveInteger(value);
        if (/^monster\d+$/u.test(slot) && id && !units.has(id)) units.set(id, level);
      }
    }
    // The invasion's level is the corruption tier, so it cannot stand in for an enemy level.
    for (const value of rows(object(stage.invasion).monster_list)) {
      const id = positiveInteger(object(value).monster_id);
      if (id && !units.has(id)) units.set(id, undefined);
    }
  }
  const enemies = await Promise.all([...units].map(async ([id, level]) => {
    const record = await enemy(String(id));
    return { name: record?.name ?? $t("starrail-challenge-data.text_e741124190", { "id": id }), artwork: record?.artwork, description: record?.description, level };
  }));
  return { name, weaknesses, enemies };
}

async function normalizeArbitration(entry: AtlasEntry, content: Record<string, unknown>,
  detail: Record<string, unknown>, images: unknown, enemy: StarrailEnemyLookup): Promise<StarrailChallengeDetails | undefined> {
  if (String(positiveInteger(detail.id)) !== entry.id) return;
  const levels = [...rows(detail.pre_level), detail.boss_level, detail.boss_config]
    .map(object).filter((level) => Object.keys(level).length);
  if (!levels.length) return;
  const rooms = await Promise.all(levels.map(async (level) => {
    const id = positiveInteger(level.id);
    const name = effectText(level.name) || effectText(level.hard_name) || (id ? $t("starrail-challenge-data.text_3b6942b7e9", { "id": id }) : $t("starrail-challenge-data.text_5caa91cf60"));
    const tags = rows(level.tag_list).map(effect).filter(({ name, description }) => name || description);
    const description = tags.map(({ name, description }) => [name, description].filter(Boolean).join("：")).join("\n");
    const optional = rows(level.buff_list).map(effect).filter(({ name }) => name);
    const side = await readSide($t("starrail-challenge-data.text_40a2cbbcce"), level.event_id_list, level.damage_type, enemy);
    const enemies = side.enemies.map((enemy) => /^[.。…\s]+$/u.test(enemy.description ?? "")
      ? { ...enemy, description: undefined } : enemy);
    return { name, description, optional, goals: [], sides: [{ ...side, enemies }] };
  }));
  return {
    name: `${arbitrationMode.name} · ${entry.name}`,
    artwork: galleryArtwork(images, "hsr")(),
    version: entry.version,
    window: readChallengeFacts(arbitrationMode, content).window,
    effects: [],
    optional: [],
    rooms,
  };
}

export async function normalizeStarrailChallenge(entry: AtlasEntry, mode: StarrailChallengeMode, content: Record<string, unknown>, images: unknown,
  enemy: StarrailEnemyLookup, current = false): Promise<StarrailChallengeDetails | undefined> {
  if (entry.game !== "hsr") return;
  const detail = object(content.detail);
  if (mode.id === arbitrationMode.id) return normalizeArbitration(entry, content, detail, images, enemy);
  const hasIdentity = positiveInteger(detail.id);
  if (hasIdentity && String(hasIdentity) !== entry.id) return;
  const chaos = mode.id === chaosMode.id;
  const levels = rows(chaos ? content.detail : detail.level).map(object).filter((row) => positiveInteger(row.id));
  if (!levels.length) return;
  const names = new Map(levels.map((level) => [level.id, effectText(level.name)]));
  const fiction = mode.id === fictionMode.id;
  const buff = effect(detail.buff);
  const descriptions = chaos ? levels.map(({ desc, param }) => gameText(desc, param)) : [];
  const normal = descriptions.filter((_, index) => !levels[index]?.pre_id);
  const [first = ""] = normal;
  const sameDescription = normal.every((description) => description === first) ? first : "";
  let effects: StarrailEffect[];
  if (chaos) effects = sameDescription ? [{ name: $t("starrail-challenge-data.text_ec3fbbc033"), description: sameDescription }] : [];
  else if (fiction) effects = [buff, ...rows(detail.sub_option).map(effect)].filter(({ name, description }) => name || description);
  else effects = [{ ...buff, name: buff.name || $t("starrail-challenge-data.text_e0711a0bb4") }];
  const optionalValues = fiction ? rows(detail.option) : [detail.buff_list1, detail.buff_list2, detail.buff_list3].flatMap(rows);
  const buffs = optionalValues.map(effect).filter(({ name }) => name);
  const optional = [...new Map(buffs.map((row) => [JSON.stringify(row), row])).values()];

  const rooms = await Promise.all(levels.map(async (level, index) => {
    const preId = positiveInteger(level.pre_id);
    const ownName = names.get(level.id) || $t("starrail-challenge-data.text_cb05285c60", { "id": level.id });
    const sideData = preId
      ? [[$t("starrail-challenge-data.text_863c08ca66"), level.event_id_list, level.damage_type]] as const
      : [[$t("starrail-challenge-data.text_3401df6359"), level.event_id_list1, level.damage_type1], [$t("starrail-challenge-data.text_38866b106e"), level.event_id_list2, level.damage_type2]] as const;
    const sides = await Promise.all(sideData.map(([name, stages, elements]) => readSide(name, stages, elements, enemy)));
    const goals = rows(level.challenge).map((value) => goalText(value, chaos)).filter(Boolean);
    const additionalGoal = goalText(level.challenge_special, chaos);
    if (additionalGoal) goals.push($t("starrail-challenge-data.text_68a8f8184f", { "additionalGoal": additionalGoal }));
    const description = descriptions[index];
    return { name: preId ? $t("starrail-challenge-data.text_039a4b8be3", { "value1": names.get(preId) || ownName }) : ownName,
      description: preId || description !== sameDescription ? description : undefined, goals, sides };
  }));
  const name = entry.name === entry.id ? $t("starrail-challenge-data.text_30180ca5b7", { "id": entry.id }) : entry.name;
  return {
    name: [current ? $t("starrail-challenge-data.text_24907e8634", { "name": mode.name }) : mode.name, name].join(" · "),
    artwork: galleryArtwork(images, "hsr")(),
    version: entry.version,
    window: readChallengeFacts(mode, content).window,
    effects,
    optional,
    rooms,
  };
}
