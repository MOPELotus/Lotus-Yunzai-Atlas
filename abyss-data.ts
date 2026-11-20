import type { AtlasEntry } from "./catalog.ts";
import { abyssMode, hasChallengeScheduleConflict, readChallengeFacts } from "./challenges.ts";
import { effectText, galleryArtwork, object } from "./source-values.ts";

interface AbyssEnemy {
  readonly name: string;
  readonly count?: number;
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

type Lineup = readonly [id: string | undefined, name: string, count: number, artwork?: string][];
type VerifiedRoom = { readonly level: number; readonly first: Lineup; readonly second: Lineup };

// November 16 release, independently checked against the in-game captures and CN lineup table.
// https://genshin.hoyoverse.com/m/en/news/detail/167187
// https://insider-gaming.com/genshin-impact/spiral-abyss-7-2-november/
// https://wiki.biligame.com/ys/index.php?title=渊月螺旋&oldid=693155
const record125Rooms: Readonly<Record<string, VerifiedRoom>> = {
  "11-1": { level: 88, first: [
    ["25133701", "嗥狼追猎者", 1], ["25133601", "牙兽狂徒", 1], ["24030201", "遗迹龙兽·地巡", 1],
  ], second: [["22140101", "深黯钓客", 12]] },
  "11-2": { level: 90, first: [
    ["25137001", "苍遒的木灵长", 1], ["25138001", "幼嫩的分节树", 2],
    ["26310801", "嵌合蝎尾怪", 1], ["26310701", "嵌合鳄蹄兽", 2],
  ], second: [["26300401", "蕴光凛狼", 1]] },
  "11-3": { level: 92, first: [["20090101", "冰结镜映体", 4]], second: [["22131001", "荒野狂狩士", 1]] },
  // The original gallery has no 20012301 thumbnail. Resolve it only through its own exact identity.
  "12-1": { level: 95, first: [["20012301", "历经百战的虹彩史莱姆", 1]], second: [["25134601", "浪涛锚定者", 1]] },
  "12-2": { level: 98, first: [["20081001", "霜夜巡天灵主", 1]], second: [["25135202", "游雪的护刃", 1]] },
  "12-3": { level: 100, first: [["26302101", "蕴光月守宫", 1]], second: [["24021101", "恒常机关阵列", 1]] },
};

// October 16 release. The footage shows one enemy in each half of chambers 2 and 3.
// https://genshin.hoyoverse.com/m/fr/news/detail/166383
// https://allthings.how/varka-stellar-swirl-and-flins-lunar-charged-in-spiral-abyss-7-1-genshin-impact/#chamber-2
// https://allthings.how/varka-stellar-swirl-and-flins-lunar-charged-in-spiral-abyss-7-1-genshin-impact/#chamber-3
// https://www.miyoushe.com/ys/article/78933070
const record124Rooms: Readonly<Record<string, VerifiedRoom>> = {
  // The 7.X table and the October historical guides agree on 24 slimes in the lower half.
  // https://wiki.biligame.com/ys/渊月螺旋/7.X
  // https://genshinflex.com/en/abyss/history/
  "11-1": { level: 88, first: [], second: [["20011101", "大型水史莱姆", 24]] },
  // The October 7.1 GenshinLab table and the 7.X archive agree on two hounds of each type.
  // https://genshinlab.com/genshin-spiral-abyss-team-comps/
  "11-2": { level: 90, first: [["21040201", "丘丘水行游侠", 2], ["26300201", "蕴光刃犀", 1]],
    second: [["22050201", "嗜雷·兽境猎犬", 2], ["22050101", "嗜岩·兽境猎犬", 2]] },
  // The October 16 in-game preview identifies the same enemies as the 7.X wave table.
  // https://trivia.k-oshiro.com/2026/10/16/genshin-spiral-abyss-2026-10/
  // https://wiki.biligame.com/ys/渊月螺旋/7.X
  "11-3": { level: 92, first: [
    ["23079301", "愚人众特辖队·雷霰近卫军", 1], ["23079101", "愚人众特辖队·火刃突击队", 1], ["26300101", "蕴光奇羊", 1],
  ], second: [["26180101", "千年珍珠骏麟", 1]] },
  // https://www.bilibili.com/video/BV1mopE6xEkd/
  // Tower 122 and RoleCombat 5/25 supply the matching Archer and Baptist portraits.
  "12-1": { level: 95,
    first: [[undefined, "历经百战的嵌合兽怪箭士", 1, "gallery/gi/UI_MonsterIcon_Volkodlak_Greyhound_Furiosa.webp"]],
    second: [
      [undefined, "深罪浸礼者·水火雷驱役者", 1, "gallery/gi/UI_MonsterIcon_Invoker_Archdeacon.webp"],
      ["22070101", "黯色空壳·旗令", 1], ["22070301", "黯色空壳·近卫", 1],
    ] },
  // Tower 117 and RoleCombat 24/28 use the same Hildegard portrait, with different encounter IDs.
  "12-2": { level: 98, first: [["26301101", "蕴光月幻蝶", 1]],
    second: [[undefined, "历经百战的盗宝团精锐", 1, "gallery/gi/UI_MonsterIcon_Thoarder_Elder_Standard_Hildegard_01.webp"]] },
  "12-3": { level: 100, first: [["26310501", "嵌合翼骏狮", 1]], second: [["24090501", "秘源机兵·统御械", 1]] },
};

// The September 16 gameplay lists the enemies and counts for both halves.
// https://www.youtube.com/watch?v=ddkJu1ItF8k
// https://genshinflex.com/en/abyss/history/
const record123Rooms: Readonly<Record<string, VerifiedRoom>> = {
  // https://timesaver.gg/blog/genshin-spiral-abyss-floor-11-7-0
  // https://wiki.biligame.com/ys/渊月螺旋/7.X
  // Tower 109 preserves the veteran Phantasm portrait under its exact combat name.
  "11-2": { level: 90, first: [
    ["25410101", "镀金旅团·魔岩役使", 1], ["25135101", "凝冰戍卫", 1], ["25135001", "凝冰秘法师", 2],
    ["25137001", "苍遒的木灵长", 1], ["25138001", "幼嫩的分节树", 2],
  ], second: [
    ["20051001", "浊水粉碎幻灵", 1],
    [undefined, "历经百战的浊水喷吐幻灵", 1, "gallery/gi/UI_MonsterIcon_Necalevia_Big.webp"],
  ] },
  // The Ousia Mek's portrait is preserved in Tower 121 and 122 under the exact combat name.
  "11-3": { level: 92, first: [
    [undefined, "建造特化型机关·荒", 1, "gallery/gi/UI_MonsterIcon_MachinaIustitia_Excavator.webp"],
    ["24030201", "遗迹龙兽·地巡", 1],
  ], second: [["22130001", "荒野幽徒", 2], ["22131001", "荒野狂狩士", 1]] },
  // https://www.youtube.com/watch?v=Hc1hYwSsulU
  // https://wiki.biligame.com/ys/渊月螺旋/7.X
  // Tower 122 preserves the Burrowbeast portrait; Tower 112 has the exact veteran Trooper portrait.
  "12-1": { level: 95,
    first: [[undefined, "历经百战的嵌合梭地兽", 1, "gallery/gi/UI_MonsterIcon_Chimera_OwlPangolin.webp"]],
    second: [["22130001", "荒野幽徒", 9],
      [undefined, "历经百战的火刃突击队员", 1, "gallery/gi/UI_MonsterIcon_Oprichnik_Male_Strong_LanceArquebus.webp"]] },
  "12-2": { level: 98, first: [["25140101", "不灭衍生造物", 1]],
    second: [["22140101", "深黯钓客", 4], ["22150101", "深黯魇语之主", 1]] },
  // https://www.youtube.com/watch?v=EXbRiGhMLjc
  // Tower 112/115 has Sigurd's original portrait. The optional Churin PNG is from HoYoWiki.
  // https://act-webstatic.hoyoverse.com/event-static-hoyowiki-admin/2026/08/03/71c24dd790c4fb4ead7003c4ad38f6d1_8199721012512592432.png
  "12-3": { level: 100,
    first: [[undefined, "历经百战的矮灵雕刻师", 1, "gallery/gi/UI_MonsterIcon_Karzelek_Tsereteli_01.png"]],
    second: [[undefined, "历经百战的执灯人", 1, "gallery/gi/UI_MonsterIcon_WildHunt_Male_Sigurd.webp"]] },
};

const verifiedPeriods = {
  "123": { name: "辉卷之月", icon: "UI_TowerBlessing_107", begin: "2026-09-16 04:00:00",
    end: "2026-10-16 03:59:59", rooms: record123Rooms },
  "124": { name: "骇星之月", icon: "UI_TowerBlessing_107", begin: "2026-10-16 04:00:00",
    end: "2026-11-16 03:59:59", rooms: record124Rooms },
  "125": { name: "凌振之月", icon: "UI_TowerBlessing_106", begin: "2026-11-16 04:00:00",
    end: "2026-12-16 03:59:59", rooms: record125Rooms },
} as const;

export async function normalizeAbyss(entry: AtlasEntry, content: Record<string, unknown>, images: unknown,
  enemy: (id: string, name: string) => Promise<AbyssEnemy | undefined>, current = false): Promise<AbyssDetails | undefined> {
  if (entry.game !== "gi") return;
  const { leyline: rawLeyline, floor, open, close } = object(content.detail);
  const floors = numbered(floor);
  if (!floors.length) return;
  const artwork = galleryArtwork(images, "gi");
  const leyline = object(rawLeyline);
  const { window } = readChallengeFacts(abyssMode, content);
  const period = entry.id === "123" || entry.id === "124" || entry.id === "125" ? verifiedPeriods[entry.id] : undefined;
  const verifiedRooms = period && window && entry.name === period.name && leyline.name === period.name && leyline.icon === period.icon &&
    (entry.version === "7.2" || entry.version === "7.2.52") &&
    open === period.begin && close === period.end && window.begin === open && window.end === close ? period.rooms : undefined;
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
      const roomName = `${floorId}-${roomId}`;
      const verified = verifiedRooms?.[roomName];
      const sides = await Promise.all((["first", "second"] as const).map(async (half, position) => {
        const rows = Array.isArray(room[half]) ? room[half] : [];
        const name = position === 0 ? "上半" : "下半";
        if (verified?.[half].length && verified.level === room.level && Array.isArray(room[half]) && !rows.length) {
          const enemies = await Promise.all(verified[half].map(async ([id, enemyName, count, originalArtwork]) => {
            const original = id ? await enemy(id, enemyName) : undefined;
            return { name: enemyName, count, artwork: originalArtwork ?? original?.artwork, description: original?.description };
          }));
          return { name, enemies };
        }
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
        return { name, enemies };
      }));
      return { name: roomName, goal: roomGoal(room), level: positiveInteger(room.level), sides };
    });
  }));
  if (!rooms.length) return;
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
