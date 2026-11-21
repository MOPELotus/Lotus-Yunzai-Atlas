import type { Game } from "./catalog.ts";
import { atlasSourceOrigin } from "./source-transport.ts";

export interface NativeAtlasImageReference {
  readonly fieldPath: string;
  readonly originalValue: string;
  readonly kind: "field" | "icon_map" | "derived";
  readonly candidates: readonly string[];
}

const iconFields = /(?:^|_)(icon|image|picture|thumbnail|avatar|portrait|figure)(?:$|_)/iu;
const imageExtension = /\.(?:png|webp|jpe?g|avif)$/iu;
const assets: Readonly<Record<string, readonly string[]>> = {
  Icon_Normal: ["Icon_Normal"], Icon_Evade: ["Icon_Evade"], Icon_Evaded: ["Icon_Evade"],
  Icon_Special: ["IconRoleSkillKeySpecial"], Icon_SpecialReady: ["IconRoleSkillKeySpecialV2"],
  Icon_SpecialReady_Rp: ["IconRoleSkillKeySpecialV3_02"], Icon_UltimateReady: ["Icon_UltimateReady"],
  Icon_Switch: ["Icon_Switch", "CardSwitch01"], Icon_QTE: ["Icon_QTE", "CardSwitch01"],
  Icon_Chain: ["Icon_UltimateReady", "TransformChain01"], Icon_Assist: ["Icon_QTE", "CardSwitch01"],
  Icon_CoreSkill: ["Icon_CoreSkill"], Icon_JoyStick: ["Icon_JoyStick"],
  Icon_AvatarClass_Attack: ["IconAttack"], Icon_AvatarClass_Anomaly: ["IconAnomaly"],
  Icon_AvatarClass_Rupture: ["IconRupture"], Icon_AvatarClass_Stun: ["IconStun"],
  Icon_GeneralBuff_PhysDmg: ["IconPhysDmg"], Icon_GeneralBuff_Thunder: ["IconThunder"],
  Icon_GeneralBuff_Fire: ["IconFire"], Icon_GeneralBuff_Ice: ["IconIce"],
  Icon_GeneralBuff_DungeonBuffEther: ["IconDungeonBuffEther"], Icon_GeneralBuff_AuricInk: ["IconAuricInk"],
  Icon_GeneralBuff_HonedEdge: ["IconHonedEdge"], Icon_GeneralBuff_Frost: ["IconFrost"],
};

function assetPath(game: Game, raw: string): string | undefined {
  if (raw.includes("\\") || raw.includes("%") || raw.includes("#") || raw.includes("?") ||
      /[\p{Cc}\p{Cf}]/u.test(raw) || raw.split("/").some(part => !part || part === "." || part === "..")) return;
  return new URL(`/assets/${game}/${raw}`, atlasSourceOrigin).href;
}

function candidates(game: Game, pageId: string, id: string, fieldPath: string, raw: string): string[] {
  const value = raw.trim();
  if (/^https?:\/\//iu.test(value)) {
    const url = URL.parse(value);
    const prefix = `/assets/${game}/`;
    if (url?.origin === atlasSourceOrigin && !url.username && !url.password && !url.search &&
        !url.hash && url.pathname.startsWith(prefix)) return [url.href];
    return [];
  }
  const routes = new Set<string>();
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "").replace(imageExtension, "");
  const parts = normalized.split("/").filter(Boolean);
  const name = parts.at(-1);
  const folder = parts.at(-2);
  if (!name) return [];
  const add = (candidate: string) => {
    const url = assetPath(game, candidate + ".webp");
    if (url) routes.add(url);
  };
  const token = /^(?:<)?IconMap:([A-Za-z0-9_]+)>?$/u.exec(value)?.[1];
  if (game === "zzz" && token) {
    for (const mapped of Object.hasOwn(assets, token) ? assets[token]! : [token]) add(mapped);
    return [...routes];
  }
  if (game === "hsr") {
    if (folder) {
      if (/ItemFigures|SpriteOutput\/(?:ItemIcon|ItemCurrency|TravelBrochure\/(?:StickFigures|StickIcons))\//iu.test(normalized)) {
        add(`itemfigures/${name}`);
      }
      if (/SpriteOutput\/SkillIcons\/Avatar\//iu.test(normalized)) {
        add(`skillicons/${name}`);
        const skill = /^SkillIcon_(\d+)(_.+)$/u.exec(name);
        const skillId = Number(skill?.[1]);
        if (skill && skillId > 10000) add(`skillicons/SkillIcon_${skillId - 10000}${skill[2]}`);
      }
      if (/MonsterFigure|SpriteOutput\/BattleEventIcon\//iu.test(normalized)) add(`monsterfigure/${name}`);
      if (/SpriteOutput\/GridFight\/AugmentBig\//iu.test(normalized)) add(`gridfight/augmentbig/${name}`);
      if (/SpriteOutput\/GridFight\/Portal\//iu.test(normalized)) add(`gridfight/portal/${name}`);
      if (/SpriteOutput\/GridFight\/(?:GridItem|Equipment)\//iu.test(normalized)) add(`gridfight/equipment/${name}`);
      if (/SpriteOutput\/GridFight\/TraitIcon\/(?:Icon|MiniIcon)\//iu.test(normalized)) {
        add(`gridfight/icon/${name}`);
        add(`gridfight/icon/${name.replace(/S$/iu, "")}`);
      }
      if (/SpriteOutput\/(?:GridFight\/BattleIcon\/BuffIcon|BuffIcon\/Inlevel\/Avatar)\//iu.test(normalized)) {
        const role = /\d+/u.exec(name)?.[0];
        if (role) add(`avatarroundicon/${role}`);
      }
      add(`${folder.toLowerCase()}/${name}`);
    }
    if (/^SkillIcon_/iu.test(name)) add(`skillicons/${name}`);
    add(normalized);
    add(name);
    if (id && pageId === "character") add(`avatarshopicon/${id}`);
  } else if (game === "gi") {
    add(name);
    const card = /^UI_AvatarIcon_(.+)_Card$/u.exec(name)?.[1];
    if (card) add("UI_AvatarIcon_" + card);
    const nameCard = /^UI_NameCardIcon_(.+)$/u.exec(name)?.[1];
    if (nameCard) {
      add(`UI_NameCardPic_${nameCard}_P`);
      add(`UI_NameCardPic_${nameCard}_Alpha`);
    }
    if (name.startsWith("Gcg_")) add("UI_" + name);
    add(normalized);
    if (pageId === "character" && fieldPath.endsWith("icon")) add(value.replace("UI_AvatarIcon_", "UI_Gacha_AvatarImg_"));
  } else {
    if (pageId === "character" && /(?:^|\.)potential_detail\.\d+\.image$/iu.test(fieldPath)) {
      add(name.startsWith("AvatarSpecialAwakenBg_") ? name : "AvatarSpecialAwakenBg_" + name);
    }
    add(name);
    if (name.startsWith("IconMonster_")) add(name.replace(/^IconMonster_/u, "Monster_"));
    add(normalized);
  }
  return [...routes];
}

export function nativeAtlasImageReferences(game: Game, pageId: string, id: string, source: unknown, prefix = ""): NativeAtlasImageReference[] {
  const found: NativeAtlasImageReference[] = [];
  function add(fieldPath: string, originalValue: string, kind: NativeAtlasImageReference["kind"]) {
    found.push({ fieldPath: prefix + fieldPath, originalValue, kind, candidates: candidates(game, pageId, id, fieldPath, originalValue) });
  }
  function visit(value: unknown, path: string) {
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries()) visit(entry, path + index + ".");
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      const fieldPath = path + key;
      if (typeof entry === "string") {
        if (game === "zzz") {
          for (const token of new Set([...entry.matchAll(/<IconMap:([A-Za-z0-9_]+)>/gu)].map(match => match[1]!))) {
            add(`${fieldPath}.IconMap.${token}`, `<IconMap:${token}>`, "icon_map");
          }
        }
        const clean = entry.trim();
        const plainType = key.toLowerCase() === "type_icon" && !/[/\\._]/u.test(clean);
        if (clean && !plainType && !/\{[^}]*\}/u.test(clean) && (iconFields.test(key) || imageExtension.test(clean))) {
          add(fieldPath, entry, "field");
        }
      } else visit(entry, fieldPath + ".");
    }
  }
  visit(source, "");
  const fields: Record<string, unknown> = source !== null && typeof source === "object" ? source as Record<string, unknown> : {};
  const derived = (field: string, value: string) => add("derived." + field, value, "derived");
  if (game === "hsr" && pageId === "character") {
    derived("avatarShopIcon", "avatarshopicon/" + id);
    derived("avatarDrawCard", "avatardrawcard/" + id);
    if (typeof fields.damageType === "string") derived("element", "element/" + fields.damageType.toLowerCase());
    if (typeof fields.baseType === "string") derived("path", "pathicon/" + fields.baseType.toLowerCase());
  }
  if (game === "hsr" && pageId === "lightcone") {
    derived("lightConeMediumIcon", "lightconemediumicon/" + id);
    if (typeof fields.baseType === "string") derived("path", "pathicon/" + fields.baseType.toLowerCase());
  }
  if (game === "hsr" && pageId === "monster" && typeof fields.icon === "string") {
    const name = fields.icon.split(/[\\/]/u).at(-1)?.replace(imageExtension, "");
    if (name) derived("monsterFigure", "monsterfigure/" + name);
  }
  if (game === "zzz" && pageId === "character") {
    for (const rank of [1, 2, 3]) derived("mindscape." + rank, `Mindscape_${id}_${rank}`);
  }
  return found;
}
