import type { AtlasEntry } from "./catalog.ts";
import { readChallengeFacts, shiyuMode } from "./challenges.ts";
import { effectText, galleryArtwork, object } from "./source-values.ts";

interface ShiyuEnemy {
  readonly name: string;
  readonly artwork?: string;
  readonly description?: string;
  readonly hp?: number;
}

interface ShiyuRoom {
  readonly name: string;
  readonly level?: number;
  readonly weaknesses: readonly string[];
  readonly resistances: readonly string[];
  readonly enemies: readonly ShiyuEnemy[];
}

interface ShiyuDefense {
  readonly name: string;
  readonly level?: number;
  readonly goals: string;
  readonly effects: readonly string[];
  readonly rooms: readonly ShiyuRoom[];
  readonly challenges: readonly ShiyuDefense[];
}

export type ShiyuPeriod = "current" | "next";

export interface ShiyuDetails {
  readonly name: string;
  readonly artwork?: string;
  readonly version: string;
  readonly window: ReturnType<typeof readChallengeFacts>["window"];
  readonly forecast: boolean;
  readonly effects: readonly { name: string; description: string }[];
  readonly defenses: readonly ShiyuDefense[];
}

const numerals = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
const rankFields = [["S", "s_rank_goal"], ["A", "a_rank_goal"], ["B", "b_rank_goal"]] as const;

function natural(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function goals(zone: Record<string, unknown>): string {
  if (zone.goal_type === 3) return "综合评级条件待核对";
  const unit = zone.goal_type === 0 ? " 秒" : zone.goal_type === 1 ? " 次战败" : zone.goal_type === 2 ? " 分" : "";
  if (!unit) return "评级条件待核对";
  const values = rankFields.flatMap(([rank, field]) => {
    const value = natural(zone[field]);
    if (value === undefined || (value === 0 && zone.goal_type !== 1)) return [];
    return [`${rank} ${value}${unit}`];
  });
  return values.join(" · ") || "评级条件待核对";
}

function labels(value: unknown): string[] {
  return Object.values(object(value)).map((item) => effectText(item)).filter(Boolean);
}

function defenseEffects(zone: Record<string, unknown>) {
  return Object.values(object(zone.layer_buff)).flatMap((value) => {
    const effect = object(value);
    const description = effectText(effect.desc);
    return description ? [{ name: effectText(effect.title) || "关卡说明", description }] : [];
  });
}

export async function normalizeShiyu(entry: AtlasEntry, content: Record<string, unknown>, images: unknown,
  enemyLookup: (id: string, name: string) => Promise<ShiyuEnemy | undefined>, period?: ShiyuPeriod): Promise<ShiyuDetails | undefined> {
  if (entry.game !== "zzz") return;
  const detail = object(content.detail);
  if (natural(detail.id) !== Number(entry.id)) return;
  const zones = Object.entries(object(detail.zone)).filter(([key]) => /^\d+$/u.test(key))
    .map(([key, value]) => [key, object(value)] as const);
  if (!zones.length) return;
  const artwork = galleryArtwork(images, "zzz");
  const effects = new Map<string, { name: string; description: string }>();
  for (const [, zone] of zones) {
    for (const effect of defenseEffects(zone)) effects.set(JSON.stringify(effect), effect);
  }

  async function readDefense(zoneId: string, zone: Record<string, unknown>, childRoom = false): Promise<ShiyuDefense> {
    const stage = natural(zone.stage_num);
    const explicitName = effectText(zone.name);
    const name = explicitName || (stage ? `第${numerals[stage] ?? stage}防线` : `防线 ID ${zoneId}（待核对）`);
    const level = natural(zone.monster_level) || undefined;
    const roomEntries = Object.entries(object(zone.layer_room)).filter(([id]) => /^\d+$/u.test(id));
    const rooms = await Promise.all(roomEntries.map(async ([roomId, value]): Promise<ShiyuRoom> => {
      const room = object(value);
      const roomName = roomEntries.length === 2 && roomId === zoneId + "1" ? "上半"
        : roomEntries.length === 2 && roomId === zoneId + "2" ? "下半" : `房间 ID ${roomId}`;
      const enemies = await Promise.all(Object.entries(object(room.monster_list)).flatMap(([key, value]) => {
        if (!/^\d+$/u.test(key)) return [];
        const enemy = object(value);
        const id = natural(enemy.id);
        const name = effectText(enemy.name);
        if (!id && !name) return [];
        const matching = id ? enemyLookup(String(id), name) : Promise.resolve(undefined);
        const hp = object(enemy.stats).hp;
        return [matching.then((known) => ({
          name: name || known?.name || `敌人 ID ${id}（待核对）`,
          artwork: artwork(`detail.zone.${zoneId}.layer_room.${roomId}.monster_list.${key}.image`) ?? known?.artwork,
          description: effectText(enemy.desc) || known?.description,
          hp: typeof hp === "number" && Number.isFinite(hp) && hp > 0 ? hp : undefined,
        }))];
      }));
      return { name: childRoom && roomEntries.length === 1 ? "" : roomName, level: natural(room.monster_level) || undefined,
        weaknesses: labels(room.monster_weakness), resistances: labels(room.monster_resistance), enemies };
    }));
    return { name, level, goals: goals(zone), effects: [...new Set(defenseEffects(zone).map((effect) => effect.name))],
      rooms, challenges: [] };
  }

  // The fifth defense refers to independently stored rooms; the combined rating is a separate record.
  const byId = new Map(zones);
  const children = new Set(zones.flatMap(([, zone]) => Array.isArray(zone.child)
    ? zone.child.map(natural).filter((value) => value !== undefined).map(String) : []));
  const defenses = await Promise.all(zones.filter(([id]) => !children.has(id)).map(async ([id, zone]) => {
    const line = await readDefense(id, zone);
    const childIds = Array.isArray(zone.child) ? zone.child.map(natural).filter((value) => value !== undefined).map(String) : [];
    const challenges = await Promise.all(childIds.map((child) => readDefense(child, byId.get(child) ?? {}, true)));
    return { ...line, challenges };
  }));
  if (!defenses.length) return;
  const title = period === "current" ? "当期式舆防卫战" : period === "next" ? "下期式舆防卫战" : shiyuMode.name;
  return {
    name: [title, entry.name === entry.id ? `记录 ID ${entry.id}` : entry.name].join(" · "),
    artwork: artwork(),
    version: entry.version,
    window: readChallengeFacts(shiyuMode, content).window,
    forecast: period === "next",
    effects: [...effects.values()],
    defenses,
  };
}
