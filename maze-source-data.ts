import { apocalypseMode, chaosMode, fictionMode, readChallengeFacts } from "./challenges.ts";
import { effectText, label, object } from "./source-values.ts";

const rotations = {
  maze: { mode: chaosMode, detailPath: "maze" },
  maze_extra: { mode: fictionMode, detailPath: "story" },
  maze_boss: { mode: apocalypseMode, detailPath: "boss" },
} as const;

export type StarrailRotationPage = keyof typeof rotations;

export function isStarrailRotationPage(pageId: string): pageId is StarrailRotationPage {
  return Object.hasOwn(rotations, pageId);
}

export function starrailSourceRotation(pageId: StarrailRotationPage) {
  return rotations[pageId];
}

export function mazeIndexMatches(pageId: StarrailRotationPage, id: string, list: Record<string, unknown>): boolean {
  if ((pageId === "maze" ? list.id !== id : list.id !== Number(id)) || !label(list.zh)) return false;
  const { mode } = rotations[pageId];
  const { live_begin, live_end, begin, end } = list;
  const live = readChallengeFacts(mode, { list }).window;
  const exported = readChallengeFacts(mode, { list: { begin, end } }).window;
  return (live_begin === "" && live_end === "" || live?.from === "live" && live.begin === live_begin && live.end === live_end) &&
    (begin === "" && end === "" || exported?.from === "export" && exported.begin === begin && exported.end === end);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function mazeSourceOutline(pageId: StarrailRotationPage, detail: unknown, name: string, id: string) {
  const envelope = object(detail);
  const levels = pageId === "maze" ? detail : envelope.level;
  if (!Array.isArray(levels) || !levels.length) return;
  if (pageId !== "maze") {
    const buffs = pageId === "maze_extra" ? ["option", "sub_option"] : ["buff_list1", "buff_list2", "buff_list3"];
    // The archived 3024 preview supplied only an ID and no formal name.
    const unnamedPreview = pageId === "maze_boss" && id === "3024" && name === id && envelope.name === null;
    if (envelope.id !== Number(id) || (!unnamedPreview && effectText(envelope.name) !== effectText(name)) ||
        envelope.buff !== object(envelope.buff) ||
        !buffs.every(field => Array.isArray(envelope[field]))) return;
  }
  const floors = new Set<string>();
  const normalFloors = new Set<number>();
  const parents = new Set<number>();
  const stages = new Set<string>();
  const enemies = new Set<string>();
  const battleEnemies = new Set<string>();
  const eliteGroups = new Set<string>();
  const difficultyGroups = new Set<string>();
  for (const value of levels) {
    const level = object(value);
    if (!positiveInteger(level.id) || floors.has(String(level.id)) || !Array.isArray(level.challenge)) return;
    floors.add(String(level.id));
    if (level.pre_id === undefined) {
      if (pageId === "maze" && (effectText(level.group_name) !== effectText(name) || !label(level.name))) return;
      if (pageId === "maze_extra" && !label(level.name)) return;
      if (pageId === "maze_boss" && level.name !== null && !label(level.name)) return;
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
        const invasion = object(stage.invasion).monster_list;
        if (invasion !== undefined) {
          if (!Array.isArray(invasion)) return;
          for (const row of invasion) {
            const { monster_id } = object(row);
            if (!positiveInteger(monster_id)) return;
            enemies.add(`${key}/invasion/${monster_id}`);
            battleEnemies.add(String(monster_id));
          }
        }
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
    const suffixes = level.pre_id === undefined ? ["1", "2"] : [""];
    for (const suffix of suffixes) {
      if (pageId === "maze_boss") {
        const boss = level[`boss_monster_id${suffix}`];
        if (!positiveInteger(boss)) return;
        enemies.add(`${level.id}/boss${suffix}/${boss}`);
        battleEnemies.add(String(boss));
      }
      if (pageId === "maze_extra") {
        const raw = level[`infinite_list${suffix}`];
        if (raw !== object(raw)) return;
        for (const [id, row] of Object.entries(object(raw))) {
          const { infinite_wave_id, monster_group_id_list, elite_group } = object(row);
          if (!positiveInteger(infinite_wave_id) || String(infinite_wave_id) !== id ||
              !positiveInteger(elite_group) || !Array.isArray(monster_group_id_list) ||
              !monster_group_id_list.every(positiveInteger)) return;
          const key = `${level.id}/infinite${suffix}/${id}`;
          stages.add(key);
          eliteGroups.add(String(elite_group));
          for (const enemy of monster_group_id_list) {
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
