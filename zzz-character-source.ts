import { object } from "./source-values.ts";

const portraitName = /^IconRole\d{1,7}(?:_[A-Za-z0-9_]{1,24})?$/u;
const localName = /^(?:Icon|AvatarSpecialAwakenBg_)[A-Za-z0-9_]{1,100}$/u;
const imageField = /^(?:icon|image|role_icon|icon_path|inter_knot_icon|spelement)$/u;
const sourceAsset = /^(?:[A-Za-z0-9_]+\/)*([A-Za-z0-9_]+)(?:\.png)?$/u;
const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;

const buttonAssets: Readonly<Record<string, readonly string[]>> = {
  Icon_Normal: ["Icon_Normal"], Icon_Evade: ["Icon_Evade"], Icon_Evaded: ["Icon_Evade"],
  Icon_Special: ["IconRoleSkillKeySpecial"], Icon_SpecialReady: ["IconRoleSkillKeySpecialV2"],
  Icon_SpecialReady_Rp: ["IconRoleSkillKeySpecialV3_02"], Icon_UltimateReady: ["Icon_UltimateReady"],
  Icon_Switch: ["Icon_Switch", "CardSwitch01"], Icon_QTE: ["Icon_QTE", "CardSwitch01"],
  Icon_Chain: ["Icon_UltimateReady", "TransformChain01"], Icon_Assist: ["Icon_QTE", "CardSwitch01"],
  Icon_CoreSkill: ["Icon_CoreSkill"], Icon_JoyStick: ["Icon_JoyStick"],
};

export function zzzCharacterIndexIcon(value: unknown) {
  return typeof value === "string" && portraitName.test(value) ? value : undefined;
}

export function matchesZzzCharacterDetail(id: string, list: Record<string, unknown>, item: Record<string, unknown>) {
  if (item.id !== Number(id) || item.rarity !== list.rank || item.icon !== list.icon ||
      typeof list.code !== "string" || typeof item.code_name !== "string" ||
      list.code.toLowerCase() !== item.code_name.toLowerCase()) return false;
  const stats = object(item.stats);
  if (!["hp_max", "hp_growth", "attack", "attack_growth", "defence", "defence_growth", "crit"].every(key => numeric(stats[key])) ||
      !numeric(stats.crit_dmg ?? stats.crit_damage)) return false;
  const levels = Object.values(object(item.level)).map(object);
  return levels.length > 0 && levels.every((level, index) => {
    const start = index === 0 ? 0 : levels[index - 1]?.level_max;
    return typeof start === "number" && level.level_min === start && typeof level.level_max === "number" &&
      Number.isSafeInteger(level.level_max) && level.level_max > start &&
      [level.hp_max, level.attack, level.defence].every(numeric);
  }) &&
    typeof object(item.partner_info).inter_knot_icon === "string" &&
    Object.keys(object(item.skill)).length > 0;
}

interface CharacterImage {
  readonly fieldPath: string;
  readonly originalValue: string;
  readonly candidates: readonly string[];
  readonly required?: true;
}

/** Nanoka uses these version-independent paths for original Zenless artwork. */
export function zzzCharacterImages(id: string, list: Record<string, unknown>, detail: unknown): readonly CharacterImage[] {
  const refs: CharacterImage[] = [];
  function walk(value: unknown, prefix: string) {
    for (const [key, child] of Object.entries(object(Array.isArray(value) ? { ...value } : value))) {
      const fieldPath = prefix ? `${prefix}.${key}` : key;
      if (typeof child !== "string") {
        walk(child, fieldPath);
        continue;
      }
      if (imageField.test(key)) {
        const name = sourceAsset.exec(child)?.[1];
        const file = name && fieldPath.startsWith("detail.potential_detail.") && key === "image"
          ? `AvatarSpecialAwakenBg_${name}` : name;
        if (file && localName.test(file)) refs.push({ fieldPath, originalValue: child, candidates: [file],
          ...(fieldPath === "icon" || fieldPath === "detail.icon" ? { required: true } : {}) });
      }
      const tokens = new Set([...child.matchAll(/<IconMap:([A-Za-z0-9_]+)>/gu)].map(match => match[1]!));
      for (const token of tokens) {
        if (Object.hasOwn(buttonAssets, token)) refs.push({ fieldPath: `${fieldPath}.IconMap.${token}`,
          originalValue: `<IconMap:${token}>`, candidates: buttonAssets[token]! });
      }
    }
  }
  walk(list, "");
  walk(detail, "detail");
  for (const rank of [1, 2, 3]) {
    const name = `Mindscape_${id}_${rank}`;
    for (const prefix of ["", "detail."]) refs.push({ fieldPath: `${prefix}derived.mindscape.${rank}`, originalValue: name, candidates: [name] });
  }
  return refs;
}
