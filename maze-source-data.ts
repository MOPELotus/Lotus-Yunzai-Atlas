import { chaosMode, readChallengeFacts } from "./challenges.ts";
import { label, object } from "./source-values.ts";

export function mazeIndexMatches(id: string, list: Record<string, unknown>): boolean {
  if (list.id !== id || !label(list.zh)) return false;
  const { live_begin, live_end, begin, end } = list;
  const live = readChallengeFacts(chaosMode, { list }).window;
  const exported = readChallengeFacts(chaosMode, { list: { begin, end } }).window;
  return (live_begin === "" && live_end === "" || live?.from === "live" && live.begin === live_begin && live.end === live_end) &&
    (begin === "" && end === "" || exported?.from === "export" && exported.begin === begin && exported.end === end);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function mazeSourceOutline(detail: unknown, name: string) {
  if (!Array.isArray(detail) || !detail.length) return;
  const floors = new Set<string>();
  const normalFloors = new Set<number>();
  const parents = new Set<number>();
  const stages = new Set<string>();
  const enemies = new Set<string>();
  const battleEnemies = new Set<string>();
  const eliteGroups = new Set<string>();
  const difficultyGroups = new Set<string>();
  for (const value of detail) {
    const level = object(value);
    if (!positiveInteger(level.id) || floors.has(String(level.id)) || !Array.isArray(level.challenge)) return;
    floors.add(String(level.id));
    if (level.pre_id === undefined) {
      if (level.group_name !== name || !label(level.name)) return;
      normalFloors.add(level.id);
    } else {
      if (!positiveInteger(level.pre_id)) return;
      parents.add(level.pre_id);
    }
    const sides = level.pre_id === undefined ? ["event_id_list1", "event_id_list2"] : ["event_id_list"];
    for (const side of sides) {
      const rooms = level[side];
      if (!Array.isArray(rooms)) return;
      for (const raw of rooms) {
        const stage = object(raw);
        if (!positiveInteger(stage.stage_id) || !positiveInteger(stage.level) || !positiveInteger(stage.hard_level_group) ||
            (stage.elite_group !== undefined && !positiveInteger(stage.elite_group)) || !Array.isArray(stage.monster_list)) return;
        const key = `${level.id}/${side}/${stage.stage_id}`;
        if (stages.has(key)) return;
        stages.add(key);
        difficultyGroups.add(`${stage.hard_level_group}/${stage.level}`);
        if (stage.elite_group !== undefined) eliteGroups.add(String(stage.elite_group));
        for (const wave of stage.monster_list) {
          const units = Object.entries(object(wave));
          if (wave !== object(wave) || !units.every(([slot, enemy]) => /^monster\d+$/u.test(slot) && positiveInteger(enemy))) return;
          for (const [, enemy] of units) {
            enemies.add(`${key}/${enemy}`);
            battleEnemies.add(String(enemy));
          }
        }
      }
    }
  }
  if (!normalFloors.size || !stages.size || [...parents].some(parent => !normalFloors.has(parent))) return;
  return { floors, stages, enemies, battleEnemies, eliteGroups, difficultyGroups };
}
