import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import type { AtlasEntry } from "./catalog.ts";
import { deadlyAssaultMode, readChallengeFacts } from "./challenges.ts";
import { effectText, galleryArtwork, label, object } from "./source-values.ts";
import { natural, zzzChallengeGoals, zzzChallengeRooms, type ZzzChallengeEnemyLookup, type ZzzChallengeRoom } from "./zzz-challenge-data.ts";

interface DeadlyAssaultEffect {
  readonly name: string;
  readonly description: string;
}

interface DeadlyAssaultEncounter {
  readonly name: string;
  readonly level?: number;
  readonly goals: string;
  readonly mechanics: readonly DeadlyAssaultEffect[];
  readonly optional: readonly DeadlyAssaultEffect[];
  readonly rooms: readonly ZzzChallengeRoom[];
}

export interface DeadlyAssaultDetails {
  readonly name: string;
  readonly artwork?: string;
  readonly version: string;
  readonly window: ReturnType<typeof readChallengeFacts>["window"];
  readonly commonOptional: readonly DeadlyAssaultEffect[];
  readonly divisions: readonly { name: string; encounters: readonly DeadlyAssaultEncounter[] }[];
}

function sourceText(value: unknown): string {
  return effectText(label(value)
    .replace(/<IconMap:[a-z0-9_]+>/giu, "")
    .replace(/<Term:\d+>([^<>]*)<\/Term>/giu, (_, name: string) => name || $t("deadly-assault-data.text_f39c9be50a")));
}

function effects(value: unknown): DeadlyAssaultEffect[] {
  return Object.values(object(value)).flatMap((row) => {
    const { title, desc } = object(row);
    if (/^\(test\d*\)|^tbd\b/iu.test(label(title))) return [];
    const description = sourceText(desc);
    return description ? [{ name: sourceText(title), description }] : [];
  });
}

export async function normalizeDeadlyAssault(entry: AtlasEntry, content: Record<string, unknown>, images: unknown,
  enemyLookup: ZzzChallengeEnemyLookup, current = false): Promise<DeadlyAssaultDetails | undefined> {
  if (entry.game !== "zzz") return;
  const detail = object(content.detail);
  if (String(natural(detail.id)) !== entry.id || !Array.isArray(detail.modes)) return;
  const modes = detail.modes.map(object);
  const artwork = galleryArtwork(images, "zzz");
  const divisions = await Promise.all(([[1001, $t("deadly-assault-data.text_5629e20a86")], [1002, $t("deadly-assault-data.text_88d514ca0b")]] as const).map(async ([zoneType, name]) => {
    const encounters = await Promise.all(modes.flatMap((mode, position) => {
      if (mode.zone_type !== zoneType) return [];
      return Object.entries(object(mode.zone)).flatMap(([id, row]) => {
        if (!/^\d+$/u.test(id)) return [];
        const zone = object(row);
        const path = `detail.modes.${position}.zone.${id}`;
        return [zzzChallengeRooms(zone, path, { artwork, enemyLookup },
          (roomId, count) => count === 1 ? "" : $t("deadly-assault-data.text_fdd4893d17", { "roomId": roomId })).then((rooms): DeadlyAssaultEncounter => ({
          name: sourceText(zone.name) || $t("deadly-assault-data.text_3b6942b7e9", { "id": id }),
          level: natural(zone.monster_level) || undefined,
          goals: zzzChallengeGoals(zone),
          mechanics: effects(zone.layer_buff),
          optional: effects(zone.selectable_buff),
          rooms,
        }))];
      });
    }));
    return { name, encounters };
  }));
  const present = divisions.filter(({ encounters }) => encounters.length);
  if (!present.length) return;
  const optional = present.flatMap(({ encounters }) => encounters.map((encounter) => encounter.optional));
  const [first = []] = optional;
  const commonOptional = optional.every((buffs) => JSON.stringify(buffs) === JSON.stringify(first)) ? first : [];
  return {
    name: current ? $t("deadly-assault-data.text_0aef3b8c0c") : $t("deadly-assault-data.text_7bdacec67a", { "name": deadlyAssaultMode.name, "id": entry.id }),
    artwork: artwork(),
    version: entry.version,
    window: readChallengeFacts(deadlyAssaultMode, content).window,
    commonOptional,
    divisions: present,
  };
}
