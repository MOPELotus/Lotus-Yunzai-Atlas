import type { AtlasEntry } from "./catalog.ts";
import { abyssMode, hasChallengeScheduleConflict, readChallengeFacts } from "./challenges.ts";
import { effectText, galleryArtwork, object } from "./source-values.ts";

interface AbyssEnemy {
  readonly name: string;
  readonly artwork?: string;
  readonly description?: string;
  readonly hp?: number;
}

interface AbyssRoom {
  readonly name: string;
  readonly goal: string;
  readonly level?: number;
  readonly sides: readonly { name: string; enemies: readonly AbyssEnemy[] }[];
}

export interface AbyssDetails {
  readonly name: string;
  readonly artwork?: string;
  readonly version: string;
  readonly window: ReturnType<typeof readChallengeFacts>["window"];
  readonly scheduleConflict: boolean;
  readonly effects: readonly { title: string; description: string }[];
  readonly rooms: readonly AbyssRoom[];
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function numbered(value: unknown) {
  return Object.entries(object(value)).filter(([id]) => /^[1-9]\d*$/u.test(id));
}

function roomGoal(room: Record<string, unknown>): string {
  const thresholds = Array.isArray(room.cond) ? room.cond : [];
  if (!thresholds.length) return "星级条件待核对";
  if (room.type === "TOWER_COND_CHALLENGE_LEFT_TIME_MORE_THAN") {
    const seconds = thresholds.map((row) => Array.isArray(row) && row.length === 2 && row[0] === 2
      ? positiveInteger(row[1]) : undefined);
    if (seconds.every((value) => value !== undefined)) return `剩余时间目标 ${seconds.join("秒 / ")}秒`;
  }
  if (room.type === "TOWER_COND_LEFT_HP_GREATER_THAN") {
    const percentages = thresholds.map((row) => Array.isArray(row) && row.length === 3 && row[1] === 3024
      && typeof row[2] === "number" && row[2] <= 100 ? positiveInteger(row[2]) : undefined);
    if (percentages.every((value) => value !== undefined)) return `防守目标剩余生命值 ${percentages.join("% / ")}%`;
  }
  return "星级条件待核对";
}

export async function normalizeAbyss(entry: AtlasEntry, content: Record<string, unknown>, images: unknown,
  enemy: (id: string, name: string) => Promise<AbyssEnemy | undefined>, current = false): Promise<AbyssDetails | undefined> {
  if (entry.game !== "gi") return;
  const { leyline: rawLeyline, floor } = object(content.detail);
  const floors = numbered(floor);
  if (!floors.length) return;
  const artwork = galleryArtwork(images, "gi");
  const leyline = object(rawLeyline);
  const description = effectText(leyline.desc);
  const effects = [{ title: "渊月祝福", description: description || "祝福说明待核对" }];
  const rooms = await Promise.all(floors.flatMap(([floorId, row]) => {
    const level = object(row);
    const buffs = Array.isArray(level.buff) ? level.buff.map((value) => effectText(value))
      .filter((buff) => buff && !/^\(test\)/iu.test(buff)) : [];
    const upperBuff = effectText(level.first_half_buff);
    const lowerBuff = effectText(level.second_half_buff);
    if (buffs.length) effects.push({ title: `第${floorId}层`, description: buffs.join(" / ") });
    if (upperBuff) effects.push({ title: `第${floorId}层上半`, description: upperBuff });
    if (lowerBuff) effects.push({ title: `第${floorId}层下半`, description: lowerBuff });

    return numbered(level.room).map(async ([roomId, value]): Promise<AbyssRoom> => {
      const room = object(value);
      const sides = await Promise.all((["first", "second"] as const).map(async (half, position) => {
        const rows = Array.isArray(room[half]) ? room[half] : [];
        const enemies = await Promise.all(rows.flatMap((value, index) => {
          const data = object(value);
          const id = positiveInteger(data.id);
          const name = effectText(data.name);
          if (!id && !name) return [];
          const known = id ? enemy(String(id), name) : Promise.resolve(undefined);
          return [known.then((detail) => ({
            name: name || detail?.name || `敌人 ID ${id}（待核对）`,
            artwork: artwork(`detail.floor.${floorId}.room.${roomId}.${half}.${index}.icon`) ?? detail?.artwork,
            description: effectText(data.desc) || detail?.description,
            hp: typeof data.hp === "number" && Number.isFinite(data.hp) && data.hp > 0 ? data.hp : undefined,
          }))];
        }));
        return { name: position === 0 ? "上半" : "下半", enemies };
      }));
      return { name: `${floorId}-${roomId}`, goal: roomGoal(room), level: positiveInteger(room.level), sides };
    });
  }));
  if (!rooms.length) return;
  const { window } = readChallengeFacts(abyssMode, content);
  const blessing = effectText(leyline.name) || (entry.name === entry.id ? "" : entry.name);
  return {
    name: [current ? "当期深境螺旋" : abyssMode.name, blessing].filter(Boolean).join(" · "),
    artwork: artwork("icon", "detail.leyline.icon") ?? artwork(),
    version: entry.version,
    window,
    scheduleConflict: hasChallengeScheduleConflict(abyssMode, entry.id, window),
    effects,
    rooms,
  };
}
