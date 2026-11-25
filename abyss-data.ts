import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { churinArtwork, prismSlimeArtwork } from "./challenge-artwork.ts";
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
  if (!thresholds.length) return $t("abyss-data.text_6e5f6af0fe");
  if (room.type === "TOWER_COND_CHALLENGE_LEFT_TIME_MORE_THAN") {
    const seconds = thresholds.map((row) => Array.isArray(row) && row.length === 2 && row[0] === 2
      ? positiveInteger(row[1]) : undefined);
    if (seconds.every((value) => value !== undefined)) return $t("abyss-data.text_801d92cb9d", { "value1": seconds.join($t("abyss-data.text_27233b4404")) });
  }
  if (room.type === "TOWER_COND_LEFT_HP_GREATER_THAN") {
    const percentages = thresholds.map((row) => Array.isArray(row) && row.length === 3 && row[1] === 3024
      && typeof row[2] === "number" && row[2] <= 100 ? positiveInteger(row[2]) : undefined);
    if (percentages.every((value) => value !== undefined)) return $t("abyss-data.text_5b69b89145", { "value1": percentages.join("% / ") });
  }
  return $t("abyss-data.text_6e5f6af0fe");
}

type Lineup = readonly [id: string | undefined, name: string, count: number, artwork?: string][];
type VerifiedRoom = { readonly level: number; readonly first: Lineup; readonly second: Lineup };

// November 16 release, independently checked against the in-game captures and CN lineup table.
// https://genshin.hoyoverse.com/m/en/news/detail/167187
// https://insider-gaming.com/genshin-impact/spiral-abyss-7-2-november/
// https://wiki.biligame.com/ys/index.php?title=渊月螺旋&oldid=693155
const record125Rooms: Readonly<Record<string, VerifiedRoom>> = {
  "11-1": { level: 88, first: [
    ["25133701", $t("abyss-data.text_3640f8f604"), 1], ["25133601", $t("abyss-data.text_c7231ae3e9"), 1], ["24030201", $t("abyss-data.text_fbab014a6f"), 1],
  ], second: [["22140101", $t("abyss-data.text_1175de4368"), 12]] },
  "11-2": { level: 90, first: [
    ["25137001", $t("abyss-data.text_d6857e21b6"), 1], ["25138001", $t("abyss-data.text_430ad167eb"), 2],
    ["26310801", $t("abyss-data.text_653594ba54"), 1], ["26310701", $t("abyss-data.text_bbd171adfc"), 2],
  ], second: [["26300401", $t("abyss-data.text_c70eaed73a"), 1]] },
  "11-3": { level: 92, first: [["20090101", $t("abyss-data.text_3f09963704"), 4]], second: [["22131001", $t("abyss-data.text_ce2d8fafd2"), 1]] },
  "12-1": { level: 95, first: [["20012301", $t("abyss-data.text_cedadf974b"), 1, prismSlimeArtwork.path]],
    second: [["25134601", $t("abyss-data.text_30c80fa5ec"), 1]] },
  "12-2": { level: 98, first: [["20081001", $t("abyss-data.text_0c18a08596"), 1]], second: [["25135202", $t("abyss-data.text_d4c0d9d07f"), 1]] },
  "12-3": { level: 100, first: [["26302101", $t("abyss-data.text_39930dd5da"), 1]], second: [["24021101", $t("abyss-data.text_6cc45d4e84"), 1]] },
};

// October 16 release. The footage shows one enemy in each half of chambers 2 and 3.
// https://genshin.hoyoverse.com/m/fr/news/detail/166383
// https://allthings.how/varka-stellar-swirl-and-flins-lunar-charged-in-spiral-abyss-7-1-genshin-impact/#chamber-2
// https://allthings.how/varka-stellar-swirl-and-flins-lunar-charged-in-spiral-abyss-7-1-genshin-impact/#chamber-3
// https://www.miyoushe.com/ys/article/78933070
const record124Rooms: Readonly<Record<string, VerifiedRoom>> = {
  // The October 16 in-game roster identifies both recon variants. The archived 7.1 GenshinLab
  // and 7.X wave tables agree on four of each and 24 Large Hydro Slimes below.
  // https://trivia.k-oshiro.com/2026/10/16/genshin-spiral-abyss-2026-10/
  // https://wiki.biligame.com/ys/渊月螺旋/7.X
  // https://genshinlab.com/genshin-spiral-abyss-team-comps/
  "11-1": { level: 88, first: [
    ["23073101", $t("abyss-data.text_3865c1360c"), 4], ["23070101", $t("abyss-data.text_ea2eba2e32"), 8],
    ["23080101", $t("abyss-data.text_2d7f065bf3"), 2], ["23080401", $t("abyss-data.text_7b006a82fb"), 4],
    ["23080201", $t("abyss-data.text_be997f83ff"), 2], ["23080501", $t("abyss-data.text_2b58e3dafc"), 4],
  ], second: [["20011101", $t("abyss-data.text_8b1237dab2"), 24]] },
  // The October 7.1 GenshinLab table and the 7.X archive agree on two hounds of each type.
  // https://genshinlab.com/genshin-spiral-abyss-team-comps/
  "11-2": { level: 90, first: [["21040201", $t("abyss-data.text_cadd28a4a1"), 2], ["26300201", $t("abyss-data.text_a601e6009c"), 1]],
    second: [["22050201", $t("abyss-data.text_56a7d1b401"), 2], ["22050101", $t("abyss-data.text_dbbde2dbad"), 2]] },
  // The October 16 in-game preview identifies the same enemies as the 7.X wave table.
  // https://trivia.k-oshiro.com/2026/10/16/genshin-spiral-abyss-2026-10/
  // https://wiki.biligame.com/ys/渊月螺旋/7.X
  "11-3": { level: 92, first: [
    ["23079301", $t("abyss-data.text_ab3797b86a"), 1], ["23079101", $t("abyss-data.text_f429401c02"), 1], ["26300101", $t("abyss-data.text_6a01a9c6a0"), 1],
  ], second: [["26180101", $t("abyss-data.text_5bf6a173a3"), 1]] },
  // https://www.bilibili.com/video/BV1mopE6xEkd/
  // Tower 122 and RoleCombat 5/25 supply the matching Archer and Baptist portraits.
  "12-1": { level: 95,
    first: [[undefined, $t("abyss-data.text_bef76149bd"), 1, "gallery/gi/UI_MonsterIcon_Volkodlak_Greyhound_Furiosa.webp"]],
    second: [
      [undefined, $t("abyss-data.text_8d7ba0d8ff"), 1, "gallery/gi/UI_MonsterIcon_Invoker_Archdeacon.webp"],
      ["22070101", $t("abyss-data.text_b7efb478d8"), 1], ["22070301", $t("abyss-data.text_e05f60a3e4"), 1],
    ] },
  // Tower 117 and RoleCombat 24/28 use the same Hildegard portrait, with different encounter IDs.
  "12-2": { level: 98, first: [["26301101", $t("abyss-data.text_d00103b2b3"), 1]],
    second: [[undefined, $t("abyss-data.text_e87385989f"), 1, "gallery/gi/UI_MonsterIcon_Thoarder_Elder_Standard_Hildegard_01.webp"]] },
  "12-3": { level: 100, first: [["26310501", $t("abyss-data.text_2aeedc74a3"), 1]], second: [["24090501", $t("abyss-data.text_3d47fda67e"), 1]] },
};

// The September 16 gameplay lists the enemies and counts for both halves.
// https://www.youtube.com/watch?v=ddkJu1ItF8k
// https://genshinflex.com/en/abyss/history/
const record123Rooms: Readonly<Record<string, VerifiedRoom>> = {
  // https://wiki.biligame.com/ys/渊月螺旋/7.X
  // https://www.18183.com/yuanshen/202609/9034833.html
  // https://www.ptt.cc/bbs/miHoYo/M.1789508957.A.15F
  // The live CN reports identify the third Landcruiser as the Cryo scout.
  // Version 7.1 fixed shooting while frozen or petrified: https://ys.mihoyo.com/main/news/detail/166392
  "11-1": { level: 88, first: [["25131001", $t("abyss-data.text_42816ffea2"), 10], ["25131601", $t("abyss-data.text_94d1fa4137"), 20]], second: [
    ["23085201", $t("abyss-data.text_53d9916fd0"), 8], ["23085301", $t("abyss-data.text_e2e96871e6"), 8],
    ["23080401", $t("abyss-data.text_7b006a82fb"), 8],
  ] },
  // https://timesaver.gg/blog/genshin-spiral-abyss-floor-11-7-0
  // https://wiki.biligame.com/ys/渊月螺旋/7.X
  // Tower 109 preserves the veteran Phantasm portrait under its exact combat name.
  "11-2": { level: 90, first: [
    ["25410101", $t("abyss-data.text_c2784ae820"), 1], ["25135101", $t("abyss-data.text_6575c25d77"), 1], ["25135001", $t("abyss-data.text_6bb1396555"), 2],
    ["25137001", $t("abyss-data.text_d6857e21b6"), 1], ["25138001", $t("abyss-data.text_430ad167eb"), 2],
  ], second: [
    ["20051001", $t("abyss-data.text_304320c421"), 1],
    [undefined, $t("abyss-data.text_24df5ddd2a"), 1, "gallery/gi/UI_MonsterIcon_Necalevia_Big.webp"],
  ] },
  // The Ousia Mek's portrait is preserved in Tower 121 and 122 under the exact combat name.
  "11-3": { level: 92, first: [
    [undefined, $t("abyss-data.text_f33bde74dc"), 1, "gallery/gi/UI_MonsterIcon_MachinaIustitia_Excavator.webp"],
    ["24030201", $t("abyss-data.text_fbab014a6f"), 1],
  ], second: [["22130001", $t("abyss-data.text_d11c9e779b"), 2], ["22131001", $t("abyss-data.text_ce2d8fafd2"), 1]] },
  // https://www.youtube.com/watch?v=Hc1hYwSsulU
  // https://wiki.biligame.com/ys/渊月螺旋/7.X
  // Tower 122 preserves the Burrowbeast portrait; Tower 112 has the exact veteran Trooper portrait.
  "12-1": { level: 95,
    first: [[undefined, $t("abyss-data.text_affcbaeab8"), 1, "gallery/gi/UI_MonsterIcon_Chimera_OwlPangolin.webp"]],
    second: [["22130001", $t("abyss-data.text_d11c9e779b"), 9],
      [undefined, $t("abyss-data.text_615c0291ec"), 1, "gallery/gi/UI_MonsterIcon_Oprichnik_Male_Strong_LanceArquebus.webp"]] },
  "12-2": { level: 98, first: [["25140101", $t("abyss-data.text_12acd5aa19"), 1]],
    second: [["22140101", $t("abyss-data.text_1175de4368"), 4], ["22150101", $t("abyss-data.text_82a4fc16d0"), 1]] },
  // https://www.youtube.com/watch?v=EXbRiGhMLjc
  // Tower 112/115 has Sigurd's original portrait. The optional Churin PNG is from HoYoWiki.
  // https://act-webstatic.hoyoverse.com/event-static-hoyowiki-admin/2026/08/03/71c24dd790c4fb4ead7003c4ad38f6d1_8199721012512592432.png
  "12-3": { level: 100,
    first: [[undefined, $t("abyss-data.text_55e852474e"), 1, churinArtwork.path]],
    second: [[undefined, $t("abyss-data.text_c2de1e0419"), 1, "gallery/gi/UI_MonsterIcon_WildHunt_Male_Sigurd.webp"]] },
};

const verifiedPeriods = {
  "123": { name: $t("abyss-data.text_51215e9754"), icon: "UI_TowerBlessing_107", begin: "2026-09-16 04:00:00",
    end: "2026-10-16 03:59:59", rooms: record123Rooms },
  "124": { name: $t("abyss-data.text_710a5e278e"), icon: "UI_TowerBlessing_107", begin: "2026-10-16 04:00:00",
    end: "2026-11-16 03:59:59", rooms: record124Rooms },
  "125": { name: $t("abyss-data.text_bfc4580a3b"), icon: "UI_TowerBlessing_106", begin: "2026-11-16 04:00:00",
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
  const effects = [{ title: $t("abyss-data.text_eb705cfb07"), description: description || $t("abyss-data.text_2b00256572") }];
  const rooms = await Promise.all(floors.flatMap(([floorId, row]) => {
    const level = object(row);
    const buffs = Array.isArray(level.buff) ? level.buff.map((value) => effectText(value))
      .filter((buff) => buff && !/^\(test\)/iu.test(buff)) : [];
    const upperBuff = effectText(level.first_half_buff);
    const lowerBuff = effectText(level.second_half_buff);
    if (buffs.length) effects.push({ title: $t("abyss-data.text_90e581898c", { "floorId": floorId }), description: buffs.join(" / ") });
    if (upperBuff) effects.push({ title: $t("abyss-data.text_c24e07b4d8", { "floorId": floorId }), description: upperBuff });
    if (lowerBuff) effects.push({ title: $t("abyss-data.text_fdfba9c7f6", { "floorId": floorId }), description: lowerBuff });

    return numbered(level.room).map(async ([roomId, value]): Promise<AbyssRoom> => {
      const room = object(value);
      const roomName = `${floorId}-${roomId}`;
      const verified = verifiedRooms?.[roomName];
      const sides = await Promise.all((["first", "second"] as const).map(async (half, position) => {
        const rows = Array.isArray(room[half]) ? room[half] : [];
        const name = position === 0 ? $t("abyss-data.text_3401df6359") : $t("abyss-data.text_38866b106e");
        if (verified?.[half].length && verified.level === room.level && Array.isArray(room[half]) && !rows.length) {
          const enemies = await Promise.all(verified[half].map(async ([id, enemyName, count, originalArtwork]) => {
            const original = id ? await enemy(id, enemyName) : undefined;
            return { name: enemyName, count, artwork: original?.artwork ?? originalArtwork, description: original?.description };
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
            name: name || detail?.name || $t("abyss-data.text_e741124190", { "id": id }),
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
    name: [current ? $t("abyss-data.text_3062d0f2d9") : abyssMode.name, blessing].filter(Boolean).join(" · "),
    artwork: artwork("icon", "detail.leyline.icon") ?? artwork(),
    version: entry.version,
    window,
    scheduleConflict: hasChallengeScheduleConflict(abyssMode, entry.id, window),
    effects,
    rooms,
  };
}
