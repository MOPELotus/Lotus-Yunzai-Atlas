import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { effectText, galleryArtwork, label, object } from "./source-values.ts";

type Json = Record<string, unknown>;
const iconPattern = /^UI_Gcg_CardFace_[A-Za-z0-9_]{1,106}$/u;
export const genshinCardPage = { id: "gcg", name: $t("gcg-data.text_8c8df27f6c") } as const;
export const genshinCardIndexIcon = (value: unknown) => {
  const icon = label(value);
  if (iconPattern.test(icon)) return icon;
};
export function matchesGenshinCardDetail(index: Json, detail: unknown) {
  const row = object(detail);
  const kind = index.type;
  if ((kind !== "Character" && kind !== "Action") || row.type !== kind || label(index.zh) !== label(row.name) ||
      !genshinCardIndexIcon(index.icon) || index.icon !== row.icon || !Array.isArray(row.tag)) return false;
  return kind !== "Character" || typeof row.hp === "number" && Number.isSafeInteger(row.hp) && row.hp >= 0 && row.hp === index.hp;
}

function plain(value: unknown) {
  return effectText(label(value).replace(/\{SPRITE_PRESET#\d+\}/gu, ""))
    .replace(/<\/?(?:b|i)\s*>/giu, "").replace(/[\p{Cc}\p{Cf}]/gu, char => char === "\n" ? char : " ").trim();
}
const dice = new Map([["CRYO", $t("gcg-data.text_ce1b850700")], ["HYDRO", $t("gcg-data.text_327b54d04f")], ["PYRO", $t("gcg-data.text_d4cfe8c82c")], ["ELECTRO", $t("gcg-data.text_5de1b913e7")],
  ["GEO", $t("gcg-data.text_9638a2a0f9")], ["ANEMO", $t("gcg-data.text_be65bd5518")], ["DENDRO", $t("gcg-data.text_91b246b5db")], ["VOID", $t("gcg-data.text_5d7906f5af")], ["SAME", $t("gcg-data.text_a56acb7c0a")], ["ENERGY", $t("gcg-data.text_c0c253c271")], ["OMNI", $t("gcg-data.text_1949905ccb")], ["LEGEND", $t("gcg-data.text_a137256a13")],
  ["SPECIAL_ENERGY", $t("gcg-data.text_2a717f01fd")], ["SKIRK_SPECIAL_ENERGY", $t("gcg-data.text_d2b9a9ed29")]]);

function costs(value: unknown) {
  const entries = Array.isArray(value) ? value.map(value => {
    const row = object(value);
    return [row.cost_type, row.count] as const;
  }) : Object.entries(object(value));
  return entries.flatMap(([type, count]) => {
    const kind = label(type).toUpperCase();
    const name = dice.get(kind.replace(/^GCG_COST_(?:DICE_)?/u, ""));
    return name && typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? [`${name} ×${count}`] : [];
  }).join(" / ");
}

function skillText(value: unknown, rawChild: unknown, references: Json) {
  const child = object(rawChild);
  return plain(label(value).replace(/\$\[([A-Za-z0-9_]+)\]/gu, (marker, rawToken: string) => {
    const key = rawToken.toLowerCase();
    const field = child[key];
    const damage = /^d__key__damage(_[0-9]+)?$/u.exec(key);
    if (damage) {
      const value = child[`d_key_damage${damage[1] ?? ""}`];
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    if (key === "d__key__element") {
      const element = label(child.d_key_element).replace(/^GCG_ELEMENT_/u, "");
      const name = dice.get(element);
      if (element === "VOID") return $t("gcg-data.text_5a93d6dea8");
      if (name) return $t("gcg-data.text_32b19b3ff2", { "name": name });
    }
    const reference = label(references[key]);
    if (/^a\d+$/u.test(key) && reference) return reference;
    return label(object(field).name) || label(field) || reference || marker;
  })).replace(/\$\[[A-Za-z0-9_]+\]/gu, "〔资料缺项〕").slice(0, 1200);
}

export function normalizeGenshinCard(id: string, version: string, content: Json, images: unknown) {
  const list = object(content.list);
  const detail = object(content.detail);
  if (!matchesGenshinCardDetail(list, detail)) return;
  const references = object(content.references);
  const tags = (detail.tag as unknown[]).map(plain).filter(Boolean).slice(0, 12);
  const type = detail.type === "Character" ? $t("gcg-data.text_e106770c98") : $t("gcg-data.text_fcaee3d650");
  const talent = object(detail.talent);
  const rawSkills = type === "角色牌" ? Object.values(talent) : [talent];
  const skills = rawSkills.map(value => {
    const row = object(value);
    return { name: plain(row.name).slice(0, 80), description: skillText(row.desc, row.child, references), cost: costs(row.cost) };
  }).filter(row => row.name && row.description).slice(0, 12);
  return {
    id, version, name: label(detail.name), type, tags, skills, description: skillText(detail.desc, undefined, references),
    artwork: galleryArtwork(images, "gi")("icon", "detail.icon"),
    hp: type === "角色牌" && typeof detail.hp === "number" ? detail.hp : undefined,
    cost: costs(detail.cost), source: plain(detail.source).slice(0, 300),
  };
}

export type GenshinCardDetails = NonNullable<ReturnType<typeof normalizeGenshinCard>>;
