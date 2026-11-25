import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { atlasLocales, defaultAtlasLocale, type AtlasLocale } from "./locale.ts";
import { createHash } from "node:crypto";
import type { Game } from "./catalog.ts";
import { legacyAtlasSourcePages, legacyIndexedOnlyPages } from "./legacy-source-profile.ts";
import { atlasSourceOrigin, readAtlasSourceBytes, type AtlasSourceFetch } from "./source-transport.ts";
import { object } from "./source-values.ts";
import { nativeAtlasImageReferences } from "./native-image-references.ts";

export type NativeAtlasPage = { readonly game: Game; readonly pageId: string; readonly version: string; readonly locale?: AtlasLocale };
type OriginImage = {
  readonly remoteUrl: string;
  readonly localPath: string;
  readonly sha256: string;
  readonly contentType: "image/webp";
  readonly bytes: number;
};
export type ReadOriginImage = (url: string) => Promise<OriginImage | undefined>;

export const nativeAtlasGameNames = {
  gi: { game: "Genshin Impact", folder: $t("native-record-export.text_d1597c51ed") },
  hsr: { game: "Honkai: Star Rail", folder: $t("native-record-export.text_a2927891f0") },
  zzz: { game: "Zenless Zone Zero", folder: $t("native-record-export.text_b1110352c9") },
} as const;

const groups: Readonly<Record<Game, Readonly<Record<string, string>>>> = {
  gi: { character: $t("native-record-export.text_c47b54e84e"), weapon: $t("native-record-export.text_4fe131173e"), artifact: $t("native-record-export.text_fc2ee58f3d"), monster: $t("native-record-export.text_40a2cbbcce"),
    "achievement/achievement": $t("native-record-export.text_52b0e1703d"), leyline: $t("native-record-export.text_b4f37d0a87"), rolecombat: $t("native-record-export.text_1ccef31aa0"), tower: $t("native-record-export.text_82f72c6585") },
  hsr: { lightcone: $t("native-record-export.text_e733238b28"), character: $t("native-record-export.text_c47b54e84e"), monster: $t("native-record-export.text_40a2cbbcce"), relicset: $t("native-record-export.text_6239fc646e"), "achievement/achievement": $t("native-record-export.text_52b0e1703d"),
    maze_boss: $t("native-record-export.text_8dae72d970"), maze: $t("native-record-export.text_59977c7f79"), maze_peak: $t("native-record-export.text_fdc6c58c58"), maze_extra: $t("native-record-export.text_d66b949b63"), monstervalue: $t("native-record-export.text_a1c6f7a65f"),
    EliteGroup: $t("native-record-export.text_c9f9d88c98"), HardLevelGroup: $t("native-record-export.text_8b9c031034"), InfiniteEliteGroup: $t("native-record-export.text_149f5763ce") },
  zzz: { weapon: $t("native-record-export.text_2ce0392ca1"), character: $t("native-record-export.text_c47b54e84e"), bangboo: $t("native-record-export.text_aa46a7c35b"), equipment: $t("native-record-export.text_d245c1825d"), monster: $t("native-record-export.text_40a2cbbcce"),
    "achievement/achievement": $t("native-record-export.text_52b0e1703d"), boss: $t("native-record-export.text_4b7b8e83d9"), shiyu: $t("native-record-export.text_f718dc4321") },
};

const pathVersion = /^(?:0|[1-9]\d{0,7})(?:\.(?:0|[1-9]\d{0,7})){1,3}(?:\+(?:0|[1-9]\d{0,14}))?$/u;
const recordId = /^[a-zA-Z0-9_-]{1,80}$/u;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const hues = { orange: 5, gold: 5, purple: 4, blue: 3, green: 2, gray: 1, grey: 1 };

export function nativeAtlasPageOrigin({ game, pageId, version, locale = defaultAtlasLocale }: NativeAtlasPage) {
  const profile = legacyAtlasSourcePages.find(row => row.game === game && row.pageId === pageId);
  if (!profile || !pathVersion.test(version) || (game !== "zzz" && version.includes("+"))) throw new Error($t("native-record-export.text_2d99d85003"));
  const sourceLocale = pageId === "achievement/achievement" ? locale : null;
  const path = `${version}/${sourceLocale ? sourceLocale + "/" : ""}${pageId}.json`;
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
  for (const part of [record[locale], object(record[locale]).name, object(record.name)[locale], record.name, record.item_name, record.en, record.codename, record.id]) {
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
  return rank ? ["", $t("native-record-export.text_b421060376"), $t("native-record-export.text_4cdaab8f22"), $t("native-record-export.text_5fdd673ed1"), $t("native-record-export.text_1077b809a5"), $t("native-record-export.text_789a6953ec"), $t("native-record-export.text_e23587866d")][rank] ?? rank + $t("native-record-export.text_83e9c51b3d") : $t("native-record-export.text_54b89f9012");
}

export async function readNativeAtlasRecord(page: NativeAtlasPage, id: string, list: unknown,
  readImage: ReadOriginImage, signal: AbortSignal | undefined, request: AtlasSourceFetch) {
  if (!recordId.test(id)) throw new Error($t("native-record-export.text_cab879dffb"));
  const { game, pageId, version, locale = defaultAtlasLocale } = page;
  const { folder, title: _, ...origin } = nativeAtlasPageOrigin(page);
  const detailUrl = legacyIndexedOnlyPages.has(game + "/" + pageId) ? undefined
    : `${atlasSourceOrigin}/${game}/${version}/${locale}/${detailPath(game, pageId)}/${id}.json`;
  const bytes = detailUrl && await readAtlasSourceBytes(detailUrl, "application/json", 8 * 1024 * 1024, true, signal, request, { retry: true });
  const detailSource = bytes ? utf8.decode(bytes) : "null";
  const detail: unknown = JSON.parse(detailSource);
  if (bytes && (detail === null || typeof detail !== "object" || (Array.isArray(detail) && !(game === "hsr" && pageId === "maze")))) throw new Error($t("native-record-export.text_72a4407f6a"));
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
  const name = recordName(list, locale) ?? recordName(detail, locale) ?? recordName(list, "en") ?? recordName(detail, "en") ?? id;
  const { game: gameName, folder: gameFolder } = nativeAtlasGameNames[game];
  const hasDetail = detail !== null;
  return { meta: { gameId: game, gameName, gameFolder, locale, localeFolder: atlasLocales[locale].folder, localeLabel: atlasLocales[locale].label,
    pageId, pageFolder: folder, ...origin, detailSourceUrl: hasDetail ? detailUrl : null, hasDetail,
    version, recordId: id, name, rarity: rarity(list, detail), images },
    content: { list, detail }, detailSource };
}

export function nativeAtlasAssetUrl(game: Game, url: string) {
  const original = new URL(url);
  const prefix = `/assets/${game}/`;
  if (original.origin !== atlasSourceOrigin || !original.pathname.startsWith(prefix) || original.username ||
      original.password || original.search || original.hash || !original.pathname.endsWith(".webp")) {
    throw new Error($t("native-record-export.text_b8a7da050d"));
  }
  return original;
}

export function nativeAtlasAssetMetadata(game: Game, url: string, bytes: Buffer): OriginImage {
  const original = nativeAtlasAssetUrl(game, url);
  const relative = original.pathname.slice(`/assets/${game}/`.length);
  return { remoteUrl: original.href, localPath: `gallery/${game}/${relative}`, sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType: "image/webp", bytes: bytes.length };
}
