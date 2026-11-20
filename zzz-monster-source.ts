import { object } from "./source-values.ts";

const primaryIcon = /^UI\/Sprite\/A1DynamicLoad\/BossCard\/UnPacker\/(?:BossCardLv\d+|CardResources)\/(Monster[_-][A-Za-z0-9_-]+|Unknown)\.png$/u;
const detailIcon = /^(?:[A-Za-z0-9_]+\/)*(Monster[_-][A-Za-z0-9_-]+|IconMonster_[A-Za-z0-9_-]+|IconRoleGeneral)\.png$/u;
const numericId = /^[1-9]\d{0,9}$/u;

export function zzzMonsterIndexIcon(value: unknown) {
  return typeof value === "string" ? primaryIcon.exec(value)?.[1] : undefined;
}

export function matchesZzzMonsterDetail(id: string, list: Record<string, unknown>, item: Record<string, unknown>) {
  const variants = object(item.monster_info);
  return item.id === Number(id) && item.rarity === list.rarity && item.group_id === list.group && item.image_path === list.icon &&
    Number.isSafeInteger(item.monster_id) && typeof item.desc === "string" && variants === item.monster_info &&
    Object.entries(variants).every(([key, raw]) => {
      const variant = object(raw);
      return numericId.test(key) && variant.id === Number(key) &&
        typeof variant.code_name === "string" && variant.code_name.length > 0 &&
        object(variant.stats) === variant.stats && typeof variant.icon === "string";
    });
}

export function zzzMonsterImages(list: Record<string, unknown>, detail: unknown) {
  const item = object(detail);
  const main = zzzMonsterIndexIcon(list.icon);
  const references = main ? [
    { fieldPath: "icon", originalValue: String(list.icon), candidates: [main] },
    { fieldPath: "detail.image_path", originalValue: String(item.image_path), candidates: [main] },
  ] : [];
  for (const [id, raw] of Object.entries(object(item.monster_info))) {
    const icon = object(raw).icon;
    const name = typeof icon === "string" && detailIcon.exec(icon)?.[1];
    if (!name) continue;
    const candidates = name.startsWith("IconMonster_") ? [name, name.replace(/^IconMonster_/u, "Monster_")] : [name];
    references.push({ fieldPath: `detail.monster_info.${id}.icon`, originalValue: String(icon), candidates });
  }
  return references;
}
