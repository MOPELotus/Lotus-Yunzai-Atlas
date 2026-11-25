import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { effectText, object } from "./source-values.ts";

interface ZzzChallengeEnemy {
  readonly name: string;
  readonly artwork?: string;
  readonly description?: string;
  readonly hp?: number;
}

export interface ZzzChallengeRoom {
  readonly name: string;
  readonly level?: number;
  readonly weaknesses: readonly string[];
  readonly resistances: readonly string[];
  readonly enemies: readonly ZzzChallengeEnemy[];
}

export type ZzzChallengeEnemyLookup = (id: string, name: string) => Promise<ZzzChallengeEnemy | undefined>;

interface ZzzChallengeSource {
  readonly artwork: (...keys: string[]) => string | undefined;
  readonly enemyLookup: ZzzChallengeEnemyLookup;
}

const rankFields = [["S", "s_rank_goal"], ["A", "a_rank_goal"], ["B", "b_rank_goal"]] as const;

export function natural(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function zzzChallengeGoals(zone: Record<string, unknown>): string {
  if (zone.goal_type === 3) return $t("zzz-challenge-data.text_2a6586afa6");
  const unit = zone.goal_type === 0 ? $t("zzz-challenge-data.text_00fe8dda1f") : zone.goal_type === 1 ? $t("zzz-challenge-data.text_d2a0828330") : zone.goal_type === 2 ? $t("zzz-challenge-data.text_b75a03ace7") : "";
  if (!unit) return $t("zzz-challenge-data.text_27ca33c097");
  const values = rankFields.flatMap(([rank, field]) => {
    const value = natural(zone[field]);
    if (value === undefined || (value === 0 && zone.goal_type !== 1)) return [];
    return [`${rank} ${value}${unit}`];
  });
  return values.join(" · ") || $t("zzz-challenge-data.text_27ca33c097");
}

function labels(value: unknown): string[] {
  return Object.values(object(value)).map((item) => effectText(item)).filter(Boolean);
}

export async function zzzChallengeRooms(zone: Record<string, unknown>, path: string,
  { artwork, enemyLookup }: ZzzChallengeSource, label: (id: string, count: number) => string): Promise<ZzzChallengeRoom[]> {
  const entries = Object.entries(object(zone.layer_room)).filter(([id]) => /^\d+$/u.test(id));
  return Promise.all(entries.map(async ([roomId, value]): Promise<ZzzChallengeRoom> => {
    const room = object(value);
    const enemies = await Promise.all(Object.entries(object(room.monster_list)).flatMap(([key, value]) => {
      if (!/^\d+$/u.test(key)) return [];
      const enemy = object(value);
      const id = natural(enemy.id);
      const name = effectText(enemy.name);
      if (!id && !name) return [];
      const matching = id ? enemyLookup(String(id), name) : Promise.resolve(undefined);
      const hp = object(enemy.stats).hp;
      return [matching.then((known) => ({
        name: name || known?.name || $t("zzz-challenge-data.text_e741124190", { "id": id }),
        artwork: artwork(`${path}.layer_room.${roomId}.monster_list.${key}.image`) ?? known?.artwork,
        description: effectText(enemy.desc) || known?.description,
        hp: typeof hp === "number" && Number.isFinite(hp) && hp > 0 ? hp : undefined,
      }))];
    }));
    return { name: label(roomId, entries.length), level: natural(room.monster_level) || undefined,
      weaknesses: labels(room.monster_weakness), resistances: labels(room.monster_resistance), enemies };
  }));
}
