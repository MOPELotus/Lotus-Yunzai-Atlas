import { deadlyAssaultMode, readChallengeFacts } from "./challenges.ts";
import { label, object } from "./source-values.ts";

import { challengeEncounterIcon as encounterIcon, challengeEnemyIcon as enemyIcon,
  challengeRecordId as recordId, positive, validAffinity } from "./zzz-challenge-source.ts";

const roleIcons = new Map([
  ["Icon_AvatarClass_Anomaly", "IconAnomaly"], ["Icon_AvatarClass_Attack", "IconAttack"],
  ["Icon_AvatarClass_Rupture", "IconRupture"], ["Icon_AvatarClass_Stun", "IconStun"], ["Icon_AvatarClass_Armorer", "IconArmorer"],
]);

interface PublishedBossRow {
  readonly id: string;
  readonly name: string;
  readonly rarity: "未分类";
  readonly list: Record<string, unknown>;
  readonly begin: string;
  readonly end: string;
}

interface BossImage {
  readonly fieldPath: string;
  readonly originalValue: string;
  readonly candidates: readonly string[];
}

export function bossSourceIndex(value: unknown, maxRecords: number): PublishedBossRow[] {
  const entries = Object.entries(object(value));
  if (!entries.length || entries.length > maxRecords) throw new Error("危局来源索引条目数无效。");
  const rows = entries.map(([id, value]): PublishedBossRow => {
    const list = object(value);
    const { window } = readChallengeFacts(deadlyAssaultMode, { list });
    if (!recordId.test(id) || list.sort !== 9 || list.zh !== "试炼" || (list.zone_type !== 1001 && list.zone_type !== 1002) ||
        window?.from !== "live" || window.begin !== list.begin || window.end !== list.end || !window.end.endsWith(":59")) {
      throw new Error(`危局来源缺少一致的实装窗口或记录身份（${id}）。`);
    }
    return { id, list, name: list.zh, rarity: "未分类", begin: window.begin, end: window.end };
  });
  const sorted = [...rows].sort((a, b) => a.begin.localeCompare(b.begin));
  if (sorted.some((entry, index) => index > 0 && sorted[index - 1]!.end >= entry.begin)) {
    throw new Error("危局来源实装窗口重叠。");
  }
  return rows;
}

function bossEffects(value: unknown, path: string, optional: boolean, images: BossImage[]): boolean {
  const rows = Object.entries(object(value));
  if (!rows.length || (optional && rows.length < 3)) return false;
  return rows.every(([key, value]) => {
    const { title, desc } = object(value);
    if (!recordId.test(key) || typeof title !== "string" || typeof desc !== "string" ||
      (optional && (!title.trim() || !desc.trim()))) return false;
    for (const match of desc.matchAll(/<IconMap:([A-Za-z0-9_]+)>/gu)) {
      const field = match[1]!;
      const name = roleIcons.get(field);
      if (name) images.push({ fieldPath: `${path}.${key}.desc.IconMap.${field}`, originalValue: match[0], candidates: [name] });
    }
    return true;
  }) && rows.some(([, row]) => label(object(row).desc));
}

export function bossSourceImages(value: unknown, entry: PublishedBossRow): BossImage[] {
  const fail = (): never => { throw new Error(`危局来源详情缺少层级、评分或原图，或与实装窗口不符（${entry.id}）。`); };
  const detail = object(value);
  if (detail.id !== Number(entry.id) || detail.name !== entry.name || detail.zone_type !== entry.list.zone_type ||
    detail.begin_time !== entry.begin || detail.end_time !== entry.end || !Array.isArray(detail.modes)) fail();
  const modes = (detail.modes as unknown[]).map(object);
  const expected = detail.zone_type === 1002 ? [1001, 1002] : [1001];
  if (modes.length !== expected.length || expected.some((type) => !modes.some((mode) => mode.zone_type === type))) fail();

  const images: BossImage[] = [];
  for (const [position, mode] of modes.entries()) {
    const zones = Object.entries(object(mode.zone));
    const expectedCount = mode.zone_type === 1001 ? 3 : 1;
    if (zones.length !== expectedCount) fail();
    const stageNumbers = new Set<unknown>();
    for (const [zoneId, rawZone] of zones) {
      const zone = object(rawZone);
      const path = `detail.modes.${position}.zone.${zoneId}`;
      const { stage_num, monster_level, s_rank_goal, a_rank_goal, b_rank_goal } = zone;
      if (!recordId.test(zoneId) || !label(zone.name) || !positive(stage_num) || !Number.isSafeInteger(stage_num) ||
        stage_num > expectedCount || stageNumbers.has(stage_num) || !positive(monster_level) ||
        zone.goal_type !== 2 || !positive(s_rank_goal) || !positive(a_rank_goal) || !positive(b_rank_goal) ||
        !(s_rank_goal > a_rank_goal && a_rank_goal > b_rank_goal) ||
        !bossEffects(zone.layer_buff, `${path}.layer_buff`, false, images)) fail();
      stageNumbers.add(stage_num);
      const rooms = Object.entries(object(zone.layer_room));
      if (!rooms.length) fail();
      for (const [roomId, rawRoom] of rooms) {
        const room = object(rawRoom);
        const roomPath = `${path}.layer_room.${roomId}`;
        const icon = encounterIcon.exec(label(room.monster_icon))?.[1];
        if (!recordId.test(roomId) || !icon || !validAffinity(room.monster_weakness) || !validAffinity(room.monster_resistance)) fail();
        const enemies = Object.entries(object(room.monster_list));
        if (!enemies.length) fail();
        const roster: BossImage[] = enemies.map(([key, value]) => {
          const enemy = object(value);
          const image = enemyIcon.exec(label(enemy.image))?.[1];
          if (!recordId.test(key) || !positive(enemy.id) || !Number.isSafeInteger(enemy.id) || !label(enemy.name) ||
              !positive(object(enemy.stats).hp) || !image) return fail();
          return { fieldPath: `${roomPath}.monster_list.${key}.image`, originalValue: label(enemy.image), candidates: [image] };
        });
        // The room icon and its same-named boss illustration are equivalent only in this source room.
        const fallback = roster.find(({ candidates }) => `Icon${candidates[0]}` === icon)?.candidates ?? [];
        images.push({ fieldPath: `${roomPath}.monster_icon`, originalValue: label(room.monster_icon),
          candidates: [icon!, ...fallback] }, ...roster);
      }
      if (!bossEffects(zone.selectable_buff, `${path}.selectable_buff`, true, images)) fail();
    }
  }
  return images;
}
