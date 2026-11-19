import type { AtlasEntry } from "./catalog.ts";
import { apocalypseMode, readChallengeFacts } from "./challenges.ts";
import { effectText, galleryArtwork, object } from "./source-values.ts";

interface ApocalypseEffect {
  readonly name: string;
  readonly description: string;
}

interface ApocalypseEnemy {
  readonly name: string;
  readonly artwork?: string;
  readonly description?: string;
}

interface ApocalypseSide {
  readonly name: string;
  readonly weaknesses: readonly string[];
  readonly enemies: readonly (ApocalypseEnemy & { readonly level?: number })[];
}

export interface ApocalypseDetails {
  readonly name: string;
  readonly artwork?: string;
  readonly version: string;
  readonly window: ReturnType<typeof readChallengeFacts>["window"];
  readonly effect: ApocalypseEffect;
  readonly optional: readonly ApocalypseEffect[];
  readonly rooms: readonly {
    readonly name: string;
    readonly goals: readonly string[];
    readonly sides: readonly ApocalypseSide[];
  }[];
}

const elements = new Map([
  ["Physical", "物理"], ["Fire", "火"], ["Ice", "冰"], ["Thunder", "雷"],
  ["Wind", "风"], ["Quantum", "量子"], ["Imaginary", "虚数"],
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

function effect(value: unknown): ApocalypseEffect {
  const { name, desc, param } = object(value);
  return { name: effectText(name), description: gameText(desc, param) };
}

export async function normalizeApocalypse(entry: AtlasEntry, content: Record<string, unknown>, images: unknown,
  enemy: (id: string) => Promise<ApocalypseEnemy | undefined>, current = false): Promise<ApocalypseDetails | undefined> {
  if (entry.game !== "hsr") return;
  const detail = object(content.detail);
  const hasIdentity = positiveInteger(detail.id);
  if (hasIdentity && String(hasIdentity) !== entry.id) return;
  const levels = rows(detail.level).map(object).filter((row) => positiveInteger(row.id));
  if (!levels.length) return;
  const names = new Map(levels.map((level) => [level.id, effectText(level.name)]));
  const buffs = [detail.buff_list1, detail.buff_list2, detail.buff_list3]
    .flatMap(rows).map(effect).filter(({ name }) => name);
  const optional = [...new Map(buffs.map((row) => [JSON.stringify(row), row])).values()];

  async function readSide(name: string, stageList: unknown, damageTypes: unknown): Promise<ApocalypseSide> {
    const weaknesses = rows(damageTypes).flatMap((value) => {
      if (typeof value !== "string") return [];
      return [elements.get(value) ?? `属性 ${value}（待核对）`];
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
      return { name: record?.name ?? `敌人 ID ${id}（待核对）`, artwork: record?.artwork, description: record?.description, level };
    }));
    return { name, weaknesses, enemies };
  }

  const rooms = await Promise.all(levels.map(async (level) => {
    const preId = positiveInteger(level.pre_id);
    const ownName = names.get(level.id) || `关卡 ID ${level.id}`;
    const sideData = preId
      ? [["星启模式", level.event_id_list, level.damage_type]] as const
      : [["上半", level.event_id_list1, level.damage_type1], ["下半", level.event_id_list2, level.damage_type2]] as const;
    const sides = await Promise.all(sideData.map(([name, stages, elements]) => readSide(name, stages, elements)));
    const goals = rows(level.challenge).flatMap((value) => {
      const { name, param } = object(value);
      const text = gameText(name, param);
      return text ? [text] : [];
    });
    const special = object(level.challenge_special);
    const additionalGoal = gameText(special.name, special.param);
    if (additionalGoal) goals.push(`额外目标 ${additionalGoal}`);
    return { name: preId ? `${names.get(preId) || ownName} · 星启模式` : ownName, goals, sides };
  }));
  const name = entry.name === entry.id ? `记录 ID ${entry.id}` : entry.name;
  return {
    name: [current ? "当期末日幻影" : apocalypseMode.name, name].join(" · "),
    artwork: galleryArtwork(images, "hsr")(),
    version: entry.version,
    window: readChallengeFacts(apocalypseMode, content).window,
    effect: effect(detail.buff),
    optional,
    rooms,
  };
}
