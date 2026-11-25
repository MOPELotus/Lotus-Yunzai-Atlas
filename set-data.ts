import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import type { AtlasEntry, Game } from "./catalog.ts";
import { effectText, galleryArtwork, label, object } from "./source-values.ts";

interface SetEffect {
  readonly pieces: number;
  readonly text: string;
}
type TitledEffect = SetEffect & { readonly title: string };

export interface SetPart {
  readonly id: string;
  readonly name: string;
  readonly artwork?: string;
}

export interface SetDetails {
  readonly game: Game;
  readonly name: string;
  readonly version: string;
  readonly artwork?: string;
  readonly effects: readonly TitledEffect[];
  readonly parts: readonly SetPart[];
  readonly story?: string;
}

function titledEffects(game: Game, detail: Record<string, unknown>): TitledEffect[] {
  if (game === "gi" && Array.isArray(detail.need) && Array.isArray(detail.affix) &&
      detail.need.length === detail.affix.length) {
    const affixes = detail.affix;
    return detail.need.flatMap((pieces, index) => {
      if (pieces !== 1 && pieces !== 2 && pieces !== 4) return [];
      const affix = object(affixes[index]);
      return [{ pieces, text: effectText(affix.desc), title: label(affix.name) || $t("set-data.text_debde1537c", { "pieces": pieces }) }];
    });
  }
  const name = label(detail.name);
  if (game === "hsr") {
    return Object.entries(object(detail.require_num)).flatMap(([count, value]) => {
      if (count !== "2" && count !== "4") return [];
      const effect = object(value);
      return [{ pieces: Number(count), title: name || $t("set-data.text_22b045500c", { "count": count }), text: effectText(effect.desc,
        Array.isArray(effect.param_list) ? effect.param_list : undefined) }];
    });
  }
  if (game === "zzz") {
    return ([2, 4] as const).flatMap((pieces) => detail[`desc${pieces}`]
      ? [{ pieces, title: name || $t("set-data.text_debde1537c", { "pieces": pieces }), text: effectText(detail[`desc${pieces}`]) }] : []);
  }
  return [];
}

export function setEffects(game: Game, detail: Record<string, unknown>): SetEffect[] {
  return titledEffects(game, detail).map(({ pieces, text }) => ({ pieces, text }));
}

export function normalizeSet(entry: AtlasEntry, content: Record<string, unknown>, images: unknown): SetDetails | undefined {
  const { game, name, version } = entry;
  const detail = object(content.detail);
  const artwork = galleryArtwork(images, game);
  const effects = titledEffects(game, detail).filter(({ text }) => text);
  const parts = game === "zzz" ? [] : Object.entries(object(detail.parts)).flatMap(([id, value]) => {
    const name = label(object(value).name);
    return name ? [{ id, name, artwork: artwork(`detail.parts.${id}.icon`) }] : [];
  });
  const story = effectText(detail.story) || effectText(detail.background);
  if (!effects.length && !parts.length && !story) return;
  return { game, name, version, artwork: artwork("detail.icon", "icon"), effects, parts, story: story || undefined };
}
