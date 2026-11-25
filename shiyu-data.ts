import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import type { AtlasEntry } from "./catalog.ts";
import { readChallengeFacts, shiyuMode } from "./challenges.ts";
import { effectText, galleryArtwork, object } from "./source-values.ts";

import { natural, zzzChallengeGoals, zzzChallengeRooms, type ZzzChallengeEnemyLookup, type ZzzChallengeRoom } from "./zzz-challenge-data.ts";

interface ShiyuDefense {
  readonly name: string;
  readonly level?: number;
  readonly goals: string;
  readonly effects: readonly string[];
  readonly rooms: readonly ZzzChallengeRoom[];
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

const numerals = ["", $t("shiyu-data.text_51a75f4634"), $t("shiyu-data.text_084b42f6e9"), $t("shiyu-data.text_a4c3313deb"), $t("shiyu-data.text_754a9d5828"), $t("shiyu-data.text_c9b87f516a"), $t("shiyu-data.text_de07b53838"), $t("shiyu-data.text_1b0542878c"), $t("shiyu-data.text_2c467d3673"), $t("shiyu-data.text_df897da6e0"), $t("shiyu-data.text_fc7edd399a")];
function defenseEffects(zone: Record<string, unknown>) {
  return Object.values(object(zone.layer_buff)).flatMap((value) => {
    const effect = object(value);
    const description = effectText(effect.desc);
    return description ? [{ name: effectText(effect.title) || $t("shiyu-data.text_5b2b40b3b8"), description }] : [];
  });
}

export async function normalizeShiyu(entry: AtlasEntry, content: Record<string, unknown>, images: unknown,
  enemyLookup: ZzzChallengeEnemyLookup, period?: ShiyuPeriod): Promise<ShiyuDetails | undefined> {
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
    const name = explicitName || (stage ? $t("shiyu-data.text_8c19c36253", { "value1": numerals[stage] ?? stage }) : $t("shiyu-data.text_d0ecc272b9", { "zoneId": zoneId }));
    const level = natural(zone.monster_level) || undefined;
    const rooms = await zzzChallengeRooms(zone, `detail.zone.${zoneId}`, { artwork, enemyLookup }, (roomId, count) => {
      if (childRoom && count === 1) return "";
      if (count === 2 && roomId === zoneId + "1") return $t("shiyu-data.text_3401df6359");
      if (count === 2 && roomId === zoneId + "2") return $t("shiyu-data.text_38866b106e");
      return $t("shiyu-data.text_fdd4893d17", { "roomId": roomId });
    });
    return { name, level, goals: zzzChallengeGoals(zone), effects: [...new Set(defenseEffects(zone).map((effect) => effect.name))],
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
  const title = period === "current" ? $t("shiyu-data.text_67c3e0660e") : period === "next" ? $t("shiyu-data.text_d8925ad8e7") : shiyuMode.name;
  return {
    name: [title, entry.name === entry.id ? $t("shiyu-data.text_30180ca5b7", { "id": entry.id }) : entry.name].join(" · "),
    artwork: artwork(),
    version: entry.version,
    window: readChallengeFacts(shiyuMode, content).window,
    forecast: period === "next",
    effects: [...effects.values()],
    defenses,
  };
}
