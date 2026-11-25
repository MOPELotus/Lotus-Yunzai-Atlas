import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { readChallengeFacts, shiyuMode } from "./challenges.ts";
import { label, object } from "./source-values.ts";
import { natural } from "./zzz-challenge-data.ts";
import { challengeEncounterIcon, challengeEnemyIcon, challengeRecordId, positive, validAffinity } from "./zzz-challenge-source.ts";

const nodeTypes = new Map([[1, "剧变节点"], [2, "稳定节点"], [3, "纷争节点"], [4, "奇袭节点"]]);
const missingRoomIcons = new Map([["62007", "62007062"], ["62011", "62011061"], ["62030", "62030062"]]);

interface PublishedShiyuRow {
  readonly id: string;
  readonly name: string;
  readonly rarity: "未分类";
  readonly list: Record<string, unknown>;
  readonly priority: number;
  readonly window?: ReturnType<typeof readChallengeFacts>["window"];
}

interface ShiyuSourceImage {
  readonly fieldPath: string;
  readonly originalValue: string;
  readonly candidates: readonly string[];
  readonly legacyMissing?: true;
}

export function shiyuSourceIndex(value: unknown, maxRecords: number): PublishedShiyuRow[] {
  const rows = Object.entries(object(value));
  if (!rows.length || rows.length > maxRecords) throw new Error($t("shiyu-source-data.text_52a5d7fffd"));
  const entries = rows.map(([id, value]): PublishedShiyuRow => {
    const list = object(value);
    const priority = natural(list.sort) ?? 0;
    const name = nodeTypes.get(priority);
    const { window } = readChallengeFacts(shiyuMode, { list });
    const validWindow = priority === 2 || priority === 3
      ? [list.begin, list.end, list.live_begin, list.live_end].every((date) => date === undefined)
      : window?.from === "live" && window.begin === list.begin && window.end === list.end && window.end.endsWith(":59");
    if (!challengeRecordId.test(id) || !name || name !== list.zh || !validWindow) {
      throw new Error($t("shiyu-source-data.text_efa3dc5028", { "id": id }));
    }
    return { id, list, name, priority, window, rarity: "未分类" };
  });
  const rotations = entries.flatMap(({ priority, window }) => priority === 1 && window ? [window] : [])
    .sort((first, second) => first.begin.localeCompare(second.begin));
  if (rotations.some((entry, index) => index > 0 && rotations[index - 1]!.end >= entry.begin)) {
    throw new Error($t("shiyu-source-data.text_59920fccdd"));
  }
  return entries;
}

function validGoals(zone: Record<string, unknown>): boolean {
  const s = natural(zone.s_rank_goal);
  const a = natural(zone.a_rank_goal);
  const b = natural(zone.b_rank_goal);
  if (s === undefined || a === undefined || b === undefined) return false;
  switch (zone.goal_type) {
    case 0:
      return s > 0 && s < a && a < b;
    case 1:
      return s === 0 && s < a && a < b;
    case 2:
    case 3:
      return s > a && a > b && b > 0;
    default:
      return false;
  }
}

export function shiyuSourceImages(value: unknown, entry: PublishedShiyuRow): ShiyuSourceImage[] {
  const fail = (): never => { throw new Error($t("shiyu-source-data.text_895a079dba", { "id": entry.id })); };
  const detail = object(value);
  const zones = new Map(Object.entries(object(detail.zone)).map(([id, zone]) => [id, object(zone)]));
  if (detail.id !== Number(entry.id) || detail.name !== entry.name || detail.priority !== entry.priority ||
      detail.begin_time !== entry.window?.begin || detail.end_time !== entry.window?.end || !zones.size) fail();

  const children = new Set<string>();
  for (const [id, zone] of zones) {
    if (!Array.isArray(zone.child)) return fail();
    if (zone.goal_type !== 3 && zone.child.length) fail();
    if (zone.goal_type === 3 && (entry.priority !== 1 || zone.stage_num !== 5 || zone.child.length !== 3)) fail();
    for (const child of zone.child) {
      const target = zones.get(String(child));
      if (!positive(child) || !Number.isSafeInteger(child) || !target || target.goal_type !== 2 ||
          target.stage_num !== zone.stage_num || String(child) === id || children.has(String(child))) fail();
      children.add(String(child));
    }
  }

  const stages = new Set<number>();
  const images: ShiyuSourceImage[] = [];
  for (const [id, zone] of zones) {
    const stage = natural(zone.stage_num);
    const nested = children.has(id);
    const combined = zone.goal_type === 3;
    const buffs = Object.values(object(zone.layer_buff)).map(object);
    if (!challengeRecordId.test(id) || !stage || (!nested && stages.has(stage)) ||
        !validGoals(zone) || !buffs.length || !buffs.every((buff) => typeof buff.title === "string" && typeof buff.desc === "string") ||
        !buffs.some((buff) => Boolean(label(buff.desc))) ||
        (combined ? zone.monster_level !== 0 : (!label(zone.name) || !positive(zone.monster_level)))) return fail();
    if (!nested) stages.add(stage);
    const rooms = Object.entries(object(zone.layer_room));
    if (combined ? rooms.length !== 0 : (nested ? rooms.length !== 1 : rooms.length < 1 || rooms.length > 2)) fail();
    for (const [roomId, rawRoom] of rooms) {
      const room = object(rawRoom);
      const path = `detail.zone.${id}.layer_room.${roomId}`;
      if (!challengeRecordId.test(roomId) || !validAffinity(room.monster_weakness) ||
          !validAffinity(room.monster_resistance) || typeof room.monster_icon !== "string") return fail();
      const roster = Object.entries(object(room.monster_list));
      if (!roster.length) fail();
      // Preserve the legacy icon order, which determines the overview artwork.
      for (const [enemyId, rawEnemy] of roster) {
        const enemy = object(rawEnemy);
        const image = challengeEnemyIcon.exec(label(enemy.image))?.[1];
        if (!challengeRecordId.test(enemyId) || !natural(enemy.id) || !label(enemy.name) ||
            !positive(object(enemy.stats).hp) || !image) return fail();
        images.push({ fieldPath: `${path}.monster_list.${enemyId}.image`, originalValue: label(enemy.image), candidates: [image] });
      }
      if (room.monster_icon) {
        const icon = challengeEncounterIcon.exec(room.monster_icon)?.[1];
        if (!icon) return fail();
        // The old published source used the identical Monster_ stem for missing IconMonster_ artwork.
        images.push({ fieldPath: `${path}.monster_icon`, originalValue: room.monster_icon,
          candidates: [icon, icon.slice(4)],
          ...(icon === "IconMonster_HeavyStrike" && missingRoomIcons.get(entry.id) === roomId ? { legacyMissing: true } : {}) });
      }
    }
  }
  const expectedStages = entry.priority === 1 ? (children.size ? 5 : 7) : entry.priority === 2 ? 10 : entry.priority === 3 ? 8 : 5;
  if (stages.size !== expectedStages || [...stages].some((stage) => stage > expectedStages)) fail();
  return images;
}
