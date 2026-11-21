import { createHash } from "node:crypto";
import type { Game } from "./catalog.ts";
import { legacyAtlasSourcePages, legacyIndexedOnlyPages } from "./legacy-source-profile.ts";
import { atlasSourceOrigin, readAtlasSourceBytes, type AtlasSourceFetch } from "./source-transport.ts";
import { object } from "./source-values.ts";
import { nativeAtlasImageReferences } from "./native-image-references.ts";

export type NativeAtlasPage = { readonly game: Game; readonly pageId: string; readonly version: string };
type OriginImage = {
  readonly remoteUrl: string;
  readonly localPath: string;
  readonly sha256: string;
  readonly contentType: "image/webp";
  readonly bytes: number;
};
export type ReadOriginImage = (url: string) => Promise<OriginImage | undefined>;

export const nativeAtlasGameNames = {
  gi: { game: "Genshin Impact", folder: "原神" },
  hsr: { game: "Honkai: Star Rail", folder: "星铁" },
  zzz: { game: "Zenless Zone Zero", folder: "绝区零" },
} as const;

const groups: Readonly<Record<Game, Readonly<Record<string, string>>>> = {
  gi: { character: "角色", weapon: "武器", artifact: "圣遗物", monster: "敌人",
    "achievement/achievement": "成就", leyline: "地脉异常", rolecombat: "幻想真境剧诗挑战", tower: "深境螺旋" },
  hsr: { lightcone: "光锥", character: "角色", monster: "敌人", relicset: "遗器套装", "achievement/achievement": "成就",
    maze_boss: "末日幻影", maze: "混沌回忆", maze_peak: "异相仲裁", maze_extra: "虚构叙事", monstervalue: "敌人数值",
    EliteGroup: "精英组", HardLevelGroup: "难度组", InfiniteEliteGroup: "无限精英组" },
  zzz: { weapon: "音擎", character: "角色", bangboo: "邦布", equipment: "驱动盘", monster: "敌人",
    "achievement/achievement": "成就", boss: "危局强袭战", shiyu: "式舆防卫战" },
};

const pathVersion = /^(?:0|[1-9]\d{0,7})(?:\.(?:0|[1-9]\d{0,7})){1,3}(?:\+(?:0|[1-9]\d{0,14}))?$/u;
const recordId = /^[a-zA-Z0-9_-]{1,80}$/u;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const hues = { orange: 5, gold: 5, purple: 4, blue: 3, green: 2, gray: 1, grey: 1 };

export function nativeAtlasPageOrigin({ game, pageId, version }: NativeAtlasPage) {
  const profile = legacyAtlasSourcePages.find(row => row.game === game && row.pageId === pageId);
  if (!profile || !pathVersion.test(version) || (game !== "zzz" && version.includes("+"))) throw new Error("无效的原图鉴分类或版本。");
  const path = version + "/" + profile.indexPath.split("/").slice(3).join("/");
  const sourceLocale = pageId === "achievement/achievement" ? "zh" : null;
  const localeMode = sourceLocale ? "path" : "embedded";
  const title = pageId.split("/").map(part => part.replace(/[_-]+/gu, " ")
    .replace(/\b\w/gu, character => character.toUpperCase())).join(" / ");
  return { title, sourcePath: path, sourceUrl: `${atlasSourceOrigin}/${game}/${path}`, sourceLocale, localeMode,
    folder: groups[game][pageId] ?? pageId };
}

function detailPath(game: Game, pageId: string) {
  if (game === "hsr") {
    if (pageId === "maze_boss") return "boss";
    if (pageId === "maze_peak") return "peak";
    if (pageId === "maze_extra") return "story";
  }
  return pageId;
}

function recordName(value: unknown, locale: string) {
  const record = object(value);
  for (const part of [record[locale], object(record.name)[locale], record.name, record.item_name, record.en, record.codename, record.id]) {
    if (typeof part === "string" && part.trim()) {
      const clean = part.replace(/\{RUBY_B#[^}]*\}/gu, "").replaceAll("{RUBY_E#}", "").replace(/<[^>]+>/gu, "").trim();
      if (clean) return clean;
    }
  }
}

function rarityRank(value: unknown) {
  const row = object(value);
  const raw = row.rarity ?? row.rank ?? row.stars ?? row.quality;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const text = String(raw ?? "");
  const rank = /(?:Rarity|Type)?([1-6])\b/u.exec(text)?.[1];
  if (rank) return Number(rank);
  return Object.entries(hues).find(([color]) => text.toLowerCase().includes(color))?.[1];
}

function rarity(list: unknown, detail: unknown) {
  const rank = rarityRank(list) ?? rarityRank(detail);
  return rank ? ["", "一星", "二星", "三星", "四星", "五星", "六星"][rank] ?? rank + "星" : "未分类";
}

export async function readNativeAtlasRecord(page: NativeAtlasPage, id: string, list: unknown,
  readImage: ReadOriginImage, signal: AbortSignal | undefined, request: AtlasSourceFetch) {
  if (!recordId.test(id)) throw new Error("无效的原图鉴条目编号。");
  const { game, pageId, version } = page;
  const { folder, title: _, ...origin } = nativeAtlasPageOrigin(page);
  const detailUrl = legacyIndexedOnlyPages.has(game + "/" + pageId) ? undefined
    : `${atlasSourceOrigin}/${game}/${version}/zh/${detailPath(game, pageId)}/${id}.json`;
  const bytes = detailUrl && await readAtlasSourceBytes(detailUrl, "application/json", 8 * 1024 * 1024, true, signal, request, { retry: true });
  const detailSource = bytes ? utf8.decode(bytes) : "null";
  const detail: unknown = JSON.parse(detailSource);
  if (bytes && (detail === null || typeof detail !== "object" || (Array.isArray(detail) && !(game === "hsr" && pageId === "maze")))) throw new Error("原图鉴详情格式无效。");
  const references = [...nativeAtlasImageReferences(game, pageId, id, list),
    ...(detail ? nativeAtlasImageReferences(game, pageId, id, detail, "detail.") : [])];
  const images = [];
  for (const { fieldPath, originalValue, kind, candidates } of references) {
    signal?.throwIfAborted();
    let image: OriginImage | undefined;
    for (const candidate of candidates) {
      image = await readImage(candidate);
      if (image) break;
    }
    if (image) images.push({ fieldPath, originalValue, kind, status: "downloaded", placeholder: false, ...image });
    else images.push({ fieldPath, originalValue, kind, status: "placeholder", placeholder: true,
      placeholderReason: "remote_missing", remoteUrl: null, localPath: "gallery/_placeholder/unknown.svg",
      sha256: null, contentType: "image/svg+xml", bytes: null });
  }
  const name = recordName(list, "zh") ?? recordName(detail, "zh") ?? recordName(list, "en") ?? recordName(detail, "en") ?? id;
  const { game: gameName, folder: gameFolder } = nativeAtlasGameNames[game];
  const hasDetail = detail !== null;
  return { meta: { gameId: game, gameName, gameFolder, locale: "zh", localeFolder: "简体中文", localeLabel: "Chinese",
    pageId, pageFolder: folder, ...origin, detailSourceUrl: hasDetail ? detailUrl : null, hasDetail,
    version, recordId: id, name, rarity: rarity(list, detail), images },
    content: { list, detail }, detailSource };
}

export function nativeAtlasAssetUrl(game: Game, url: string) {
  const original = new URL(url);
  const prefix = `/assets/${game}/`;
  if (original.origin !== atlasSourceOrigin || !original.pathname.startsWith(prefix) || original.username ||
      original.password || original.search || original.hash || !original.pathname.endsWith(".webp")) {
    throw new Error("原图地址未指向对应游戏的 Nanoka CDN。");
  }
  return original;
}

export function nativeAtlasAssetMetadata(game: Game, url: string, bytes: Buffer): OriginImage {
  const original = nativeAtlasAssetUrl(game, url);
  const relative = original.pathname.slice(`/assets/${game}/`.length);
  return { remoteUrl: original.href, localPath: `gallery/${game}/${relative}`, sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType: "image/webp", bytes: bytes.length };
}
