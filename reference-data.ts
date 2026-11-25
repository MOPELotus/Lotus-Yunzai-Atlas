import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { effectText, label, object } from "./source-values.ts";

type RecordValue = Record<string, unknown>;

const statLabels: Readonly<Record<string, string>> = {
  hp: $t("reference-data.text_1a256e6376"), atk: $t("reference-data.text_b84ee11f4f"), def: $t("reference-data.text_1cb579e6ba"), speed: $t("reference-data.text_0e14d148b4"), speed_base: $t("reference-data.text_0e14d148b4"),
  hp_base: $t("reference-data.text_1a256e6376"), attack_base: $t("reference-data.text_b84ee11f4f"), defence_base: $t("reference-data.text_1cb579e6ba"),
  BASE_HP: $t("reference-data.text_3277ed325c"), BASE_ATTACK: $t("reference-data.text_9a2ba9f61e"), BASE_DEFENSE: $t("reference-data.text_b953c90f99"),
};

function referenceText(value: unknown, depth = 0): string {
  if (typeof value === "string") return effectText(value.replace(/<\/?[ib]>/giu, ""));
  if (depth >= 8 || !value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map((entry) => referenceText(entry, depth + 1)).filter(Boolean).join("\n");
  const row = object(value);
  const param = row.param ?? row.param_list;
  const description = Array.isArray(param) && typeof row.desc === "string"
    ? effectText(row.desc, param) : referenceText(row.desc, depth + 1);
  return [effectText(row.name), description].filter(Boolean).join("：");
}

function firstText(values: readonly unknown[]): string {
  for (const value of values) {
    const text = referenceText(value);
    if (text) return text;
  }
  return "";
}

function referenceMaterials(value: unknown, materialNames: RecordValue): string {
  const items: string[] = [];
  const seen = new Set<string>();
  function collect(source: unknown, depth: number) {
    if (!source || typeof source !== "object" || depth >= 10 || items.length >= 8) return;
    const row = object(source);
    const rawId = row.id;
    const id = typeof rawId === "number" ? String(rawId) : label(rawId);
    const name = referenceText(row.name) || referenceText(row.title) || (id && referenceText(materialNames[id]));
    if (!name) {
      for (const item of Object.values(source)) collect(item, depth + 1);
      return;
    }
    const count = row.count ?? row.num ?? row.amount;
    const amount = typeof count === "string" && /^\d+$/u.test(count) ? Number(count) : count;
    const suffix = typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? ` × ${amount}` : "";
    const line = name + suffix;
    if (seen.has(line)) return;
    seen.add(line);
    items.push(line);
  }
  collect(value, 0);
  return items.join("\n");
}

function referenceStats(value: unknown): string {
  return Object.entries(object(value)).flatMap(([key, value]) => {
    const name = Object.hasOwn(statLabels, key) ? statLabels[key] : /\p{Script=Han}/u.test(key) ? label(key) : "";
    if (!name) return [];
    if (typeof value === "number" && Number.isFinite(value)) return [`${name}：${value}`];
    const text = referenceText(value);
    return text ? [`${name}：${text}`] : [];
  }).slice(0, 6).join(" · ");
}

export function referenceContent(list: RecordValue, detail: RecordValue, materialNames: RecordValue) {
  const partner = object(detail.partner_info);
  const intro = firstText([partner.profile_desc, detail.desc, detail.description, detail.profile_desc,
    list.desc, list.description, list.effect, detail.effect, detail.story, detail.item_desc, detail.item_bg_desc]);
  const sections = [
    { title: $t("reference-data.text_86a00cf742"), content: firstText([detail.effect, list.effect, detail.desc2, list.desc2]) },
    { title: $t("reference-data.text_a7ad704923"), content: firstText([object(detail.special_element_type).desc, partner.impression_f, partner.impression_m]) },
    { title: $t("reference-data.text_c5500a58e0"), content: referenceStats(detail.stats ?? detail.weapon_prop ?? list.stats) },
    { title: $t("reference-data.text_4c2c5762d3"), content: firstText([detail.story, detail.background, object(partner.trust_lv)["3"], detail.item_bg_desc]) },
    { title: $t("reference-data.text_2d84990389"), content: referenceMaterials(detail.materials ?? detail.ascension ?? detail.level, materialNames) },
  ].filter(({ content }) => content && content !== intro);
  return { intro, sections };
}
