import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import type { AtlasEntry } from "./catalog.ts";
import { onslaughtMode, readChallengeFacts } from "./challenges.ts";
import { effectText, galleryArtwork, label, object } from "./source-values.ts";

const difficulties = [{ rawLevel: 104, label: "N5", level: 105 }, { rawLevel: 109, label: "N6", level: 110 }] as const;
type Difficulty = typeof difficulties[number]["label"];

interface OnslaughtEnemy {
  readonly name: string;
  readonly artwork?: string;
  readonly mechanics: string;
  readonly variants: readonly { difficulty: Difficulty; level: number; description: string }[];
}

export interface OnslaughtDetails {
  readonly name: string;
  readonly version: string;
  readonly window: ReturnType<typeof readChallengeFacts>["window"];
  readonly artwork?: string;
  readonly rules: readonly { difficulty: Difficulty; description: string }[];
  readonly enemies: readonly OnslaughtEnemy[];
}

function clean(value: unknown): string {
  return effectText(value).replace(/\n{2,}/gu, "\n").trim();
}

function rows(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : Object.values(object(value));
}

function enemyMechanics(source: Record<string, unknown>): string {
  const names = rows(source.monster_buff_name_list).map(clean);
  const mechanics = new Set<string>();
  for (const [group, suffix] of [[source.monster_buff_desc_list, ""], [source.monster_buff_detail_list, $t("onslaught-data.text_979a332955")]] as const) {
    for (const [index, value] of rows(group).entries()) {
      const text = clean(value);
      if (!text) continue;
      const name = names[index];
      mechanics.add(name ? `${name}${suffix}：${text}` : text);
    }
  }
  return [...mechanics].join("\n");
}

export function normalizeOnslaught(entry: AtlasEntry, content: Record<string, unknown>, images: unknown): OnslaughtDetails | undefined {
  const detail = object(content.detail);
  if (entry.game !== "gi" || String(detail.id) !== entry.id || label(detail.name) !== entry.name) return;
  const sourceLevels = Object.entries(object(detail.level));
  const artwork = galleryArtwork(images, "gi");
  const rules: OnslaughtDetails["rules"][number][] = [];
  const enemies = new Map<string, {
    name: string; artwork?: string; mechanics: string; variants: OnslaughtEnemy["variants"][number][];
  }>();

  for (const { rawLevel, label: difficulty, level } of difficulties) {
    const levels = sourceLevels.filter(([, value]) => object(value).monster_level === rawLevel);
    const [selected] = levels;
    if (!selected || levels.length !== 1) return;
    const [difficultyId, data] = selected;
    const source = object(data);
    const description = rows(object(source.difficulty_config).desc_list).map(clean).filter(Boolean).join("\n");
    if (description) rules.push({ difficulty, description });
    const configurations = Object.entries(object(source.level_config));
    if (!configurations.length) return;
    for (const [id, data] of configurations) {
      const enemy = object(data);
      const name = clean(enemy.name);
      if (!/^[1-9]\d*$/u.test(id) || !name) return;
      const previous = enemies.get(id);
      if (previous && previous.name !== name) return;
      const mechanics = enemyMechanics(enemy);
      const item = previous ?? { name, mechanics, variants: [], artwork: undefined };
      item.artwork ??= artwork(`detail.level.${difficultyId}.level_config.${id}.icon`);
      const description = [clean(enemy.desc).slice(0, 420), mechanics].filter(Boolean).join("\n");
      item.variants.push({ difficulty, level, description });
      enemies.set(id, item);
    }
  }

  return { name: entry.name, version: entry.version, window: readChallengeFacts(onslaughtMode, content).window,
    artwork: artwork(), rules, enemies: [...enemies.values()] };
}
