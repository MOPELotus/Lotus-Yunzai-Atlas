import { createHash, randomInt } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ImageSizeLimitError, nativeImageRasterScale, renderPng } from "@lotus-yunzai/skia";
import { Canvas, FontLibrary, loadImage, type CanvasRenderingContext2D as Context, type Image } from "skia-canvas";
import { gameNames, type Game, type MonsterDetails } from "./catalog.ts";
import { localPanelGalleryRoot, readSyncedPanelGalleryRoot } from "../../lib/panel-gallery-paths.ts";
import type { AchievementCategory } from "./achievements.ts";
import type { BangbooDetails } from "./bangboo-data.ts";
import type { RoleDetails, RoleSkillCard, RoleText } from "./role-data.ts";
import type { WeaponDetails } from "./weapon-data.ts";
import type { SetDetails, SetPart } from "./set-data.ts";
import type { GenshinCardDetails } from "./gcg-data.ts";
import type { OnslaughtDetails } from "./onslaught-data.ts";
import type { TheaterDetails } from "./theater-data.ts";
import type { AbyssDetails } from "./abyss-data.ts";
import { challengeArtworkDigests } from "./challenge-artwork.ts";
import type { StarrailChallengeDetails } from "./starrail-challenge-data.ts";
import type { ShiyuDetails } from "./shiyu-data.ts";
import type { DeadlyAssaultDetails } from "./deadly-assault-data.ts";
import type { ZzzChallengeRoom } from "./zzz-challenge-data.ts";
import { isAtlasGalleryPath, label, object } from "./source-values.ts";
import { atlasThemeDirectories } from "./theme-directories.ts";
import type { RoleSection } from "./traditional.ts";

export interface RoleRenderOptions {
  readonly mode?: "auto" | "gpu" | "cpu";
  readonly scale?: number;
  readonly assetRoot?: string;
  readonly inlineImageByteLimit?: number;
  readonly galleryName?: string | readonly string[];
  readonly qFace?: boolean;
}

const width = 800;
const margin = 24;
const inner = width - 2 * margin;
const contentWidth = inner - 40;
const header = 184;
const footer = 62;
const maxImageBytes = 8 * 1024 * 1024;
const font = '"MiaoWiki", MiSans, "Noto Sans CJK SC", sans-serif';
const gold = "#d3bc8e";
const white = "#f1efed";
const muted = "#c2c5cb";
const backgrounds = [
  [/量子/u, "quantum"], [/虚数|岩/u, "geo"], [/火/u, "pyro"], [/水/u, "hydro"], [/冰|霜/u, "cryo"],
  [/风/u, "anemo"], [/雷|电/u, "electro"], [/草/u, "dendro"],
] as const;

type Background = (typeof backgrounds)[number][1] | "sr";
type ThemeAsset = `bg/${"bg" | "talent"}-${Background}.webp` | "card-bg.png";
const themeOverride = Bun.env.LOTUS_ATLAS_THEME_DIR?.trim();
const themeDirectories = atlasThemeDirectories(import.meta.url, themeOverride);
const portraitDonor = themeOverride ? undefined : Bun.env.LOTUS_ATLAS_THEME_SOURCE_DIR?.trim();
const portraitDirectories = portraitDonor ? [...new Set([...themeDirectories, portraitDonor])] : themeDirectories;
const themeImages = new Map<ThemeAsset, Promise<Image | undefined>>();
let themeFonts: Promise<void> | undefined;

async function loadThemeFonts(): Promise<void> {
  for (const [family, filename] of [["MiaoWiki", "HYWH-65W.ttf"], ["MiSans", "MiSans-VF.ttf"]] as const) {
    const paths = themeDirectories.flatMap((directory) => family === "MiSans"
      ? [join(directory, "fonts", filename), join(dirname(directory), "fonts", filename)]
      : [join(directory, "fonts", filename)]);
    for (const path of paths) {
      if (!await Bun.file(path).exists()) continue;
      FontLibrary.use(family, [path]);
      break;
    }
  }
}

async function readThemeImage(asset: ThemeAsset): Promise<Image | undefined> {
  for (const directory of themeDirectories) {
    try {
      const bytes = await Bun.file(join(directory, asset)).arrayBuffer();
      return await loadImage(Buffer.from(bytes));
    } catch {
      // Try the original module fallback if the persistent directory has no readable copy.
    }
  }
}

function themeImage(asset: ThemeAsset): Promise<Image | undefined> {
  let image = themeImages.get(asset);
  if (!image) {
    image = readThemeImage(asset);
    themeImages.set(asset, image);
  }
  return image;
}

type Block = { readonly height: number; paint(ctx: Context, top: number): void };
type Page = { section: string; panels: Block[][]; trailingGap?: false; continuation?: Block[][] };
type RoleSectionStyle = {
  readonly headerHeight: number;
  readonly paintHeader: (ctx: Context, section: string, page: string) => void;
  readonly panelBackground?: Image;
};

function rounded(ctx: Context, x: number, y: number, w: number, h: number, radius: number, fill: string) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fill();
}

function paintLines(ctx: Context, lines: readonly string[], x: number, y: number, size: number,
  lineHeight: number, color: string) {
  ctx.font = `${size}px ${font}`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = color;
  for (const [row, line] of lines.entries()) ctx.fillText(line, x, y + row * lineHeight);
}

function contain(ctx: Context, image: Image, x: number, y: number, w: number, h: number) {
  const scale = Math.min(w / image.width, h / image.height);
  const dw = image.width * scale;
  const dh = image.height * scale;
  ctx.drawImage(image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function makeLayout(texture?: Image, sectionIcon?: Image) {
  const metrics = new Canvas(1, 1);
  metrics.gpu = false;
  const measure = metrics.getContext("2d");

  function wrap(text: string, maxWidth: number, size: number) {
    measure.font = `${size}px ${font}`;
    return text.split(/\r?\n/u).flatMap((paragraph) => {
      const lines: string[] = [];
      let line = "";
      const add = (token: string) => {
        if (line && measure.measureText(line + token).width > maxWidth) {
          lines.push(line.trimEnd());
          line = token.trimStart();
        } else line += token;
      };
      for (const token of paragraph.match(/[-+]?\d+(?:[.,]\d+)*%?|[A-Za-z][A-Za-z0-9.-]*|./gu) ?? []) {
        if (measure.measureText(token).width > maxWidth) Array.from(token).forEach(add);
        else add(token);
      }
      lines.push(line.trimEnd());
      return lines;
    });
  }

  function text(value: string, color = white, size = 19, lineHeight = size + 10): Block {
    const lines = wrap(value, contentWidth, size);
    return { height: lines.length * lineHeight + 20, paint: (ctx, top) =>
      paintLines(ctx, lines, margin + 20, top + 10, size, lineHeight, color) };
  }

  function heading(value: string, artwork?: Image, small = false, subtitle?: string): Block {
    const size = small ? 21 : 26;
    const lineHeight = size + 8;
    const wideIcon = artwork && sectionIcon;
    const x = wideIcon ? 175 : artwork ? 122 : 44;
    const lines = wrap(value, inner - (wideIcon ? 178 : artwork ? 124 : 40), size);
    const minHeight = small ? 48 : wideIcon ? 120 : 82;
    return { height: Math.max(minHeight, lines.length * lineHeight + (small ? 24 : 35)), paint(ctx, top) {
      if (texture) ctx.drawImage(texture, margin, top, inner, this.height);
      if (wideIcon && artwork) {
        contain(ctx, wideIcon, 38, top + 4, 112, 112);
        contain(ctx, artwork, 68, top + 34, 52, 52);
      } else if (artwork) {
        rounded(ctx, 40, top + 11, 62, 62, 31, "rgba(255,255,255,0.10)");
        contain(ctx, artwork, 49, top + 20, 44, 44);
      }
      paintLines(ctx, lines, x, top + (small ? 12 : 14), size, lineHeight, gold);
      if (subtitle) paintLines(ctx, [subtitle], x, top + 19 + lines.length * lineHeight, 14, 21, muted);
    } };
  }

  function row(values: readonly string[], widths: readonly number[], title = false): Block {
    const size = 17;
    const lineHeight = 25;
    const cells = values.map((value, index) => wrap(value, widths[index]! - 12, size));
    const height = Math.max(title ? 44 : 40, ...cells.map((cell) => cell.length * lineHeight + 14));
    return { height, paint(ctx, top) {
      if (title) {
        ctx.fillStyle = "rgba(211,188,142,0.19)";
        ctx.fillRect(margin, top, inner, height);
      }
      let x = margin + 20;
      for (const [index, lines] of cells.entries()) {
        paintLines(ctx, lines, x + 6, top + 10, size, lineHeight, title ? gold : white);
        x += widths[index]!;
      }
      ctx.fillStyle = "rgba(255,255,255,0.09)";
      ctx.fillRect(margin + 20, top + height - 1, contentWidth, 1);
    } };
  }

  function statRow(stats: readonly { label: string; value: string }[]): Block {
    const labelSize = 16;
    const valueSize = 23;
    const cells = stats.map(({ label, value }) => ({
      labels: wrap(label, 212, labelSize),
      values: wrap(value, 212, valueSize),
    }));
    const height = Math.max(90, ...cells.map(({ labels, values }) => 20 + labels.length * 24 + values.length * 30));
    return { height, paint(ctx, top) {
      for (const [index, { labels, values }] of cells.entries()) {
        const x = 48 + index * (inner / 3);
        paintLines(ctx, labels, x, top + 14, labelSize, 24, muted);
        paintLines(ctx, values, x, top + 18 + labels.length * 24, valueSize, 30, gold);
      }
    } };
  }

  function material(name: string, count: number | undefined, artwork?: Image): Block {
    const lines = wrap(name, inner - 180, 20);
    const quantity = count === undefined ? [] : wrap(`× ${count}`, 102, 21);
    const height = Math.max(86, lines.length * 28 + 26, quantity.length * 28 + 26);
    return { height, paint(ctx, top) {
      if (artwork) contain(ctx, artwork, 40, top + 11, 60, 60);
      paintLines(ctx, lines, artwork ? 120 : 44, top + 24, 20, 28, white);
      paintLines(ctx, quantity, 654, top + 26, 21, 28, gold);
    } };
  }

  function levelBlocks(levels: NonNullable<RoleSkillCard["levels"]>): Block[] {
    const result: Block[] = [];
    const titles = levels.map(({ level, sourceId }, _, all) => all.filter((entry) => entry.level === level).length > 1 && sourceId
      ? `等级 ${level} · ${sourceId}` : `等级 ${level}`);
    const descriptions = new Map<string, { index: number; parts: string[] }[]>();
    const numeric = /^\d/u;
    for (const [index, { description }] of levels.entries()) {
      if (!description) continue;
      const parts = description.match(/\d+(?:[.,]\d+)*%?|[^\d]+/gu) ?? [];
      const key = JSON.stringify(parts.map((part) => numeric.test(part) ? null : part));
      const matches = descriptions.get(key) ?? [];
      matches.push({ index, parts });
      descriptions.set(key, matches);
    }
    // Each distinct prose variant keeps its wording and associates changing values with the exact source levels.
    const valuesByLevel = levels.map((): RoleText[] => []);
    let variable = 0;
    for (const matches of descriptions.values()) {
      const first = matches[0]!;
      result.push(text(matches.map(({ index }) => titles[index]!).join(" / "), gold, 17));
      result.push(text(first.parts.map((part, index) => {
        if (matches.every((entry) => entry.parts[index] === part)) return part;
        const label = `数值 ${++variable}`;
        for (const entry of matches) valuesByLevel[entry.index]!.push({ label, text: entry.parts[index]! });
        return `〔${label}〕`;
      }).join("")));
    }

    for (let start = 0; start < levels.length; start += 4) {
      const group = levels.slice(start, start + 4);
      const extras = valuesByLevel.slice(start, start + group.length);
      if (!extras.some((values) => values.length) && !group.some(({ details }) => details.length)) continue;
      const labelWidth = 280;
      const widths = [labelWidth, ...group.map(() => (contentWidth - labelWidth) / group.length)];
      result.push(row(["等级数值", ...titles.slice(start, start + group.length)], widths, true));
      const details = new Map<string, { label: string; values: string[] }>();
      for (const [column, level] of group.entries()) {
        const occurrences = new Map<string, number>();
        for (const entry of [...extras[column]!, ...level.details]) {
          const label = entry.label || "说明";
          const index = (occurrences.get(label) ?? 0) + 1;
          occurrences.set(label, index);
          const key = JSON.stringify([label, index]);
          const values = details.get(key) ?? { label, values: group.map(() => "") };
          values.values[column] = entry.text;
          details.set(key, values);
        }
      }
      for (const { label, values } of details.values()) result.push(row([label, ...values], widths));
    }
    return result;
  }

  return { wrap, text, heading, row, statRow, material, levelBlocks };
}

async function localAsset(path: string, maxBytes: number): Promise<Buffer | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) return;
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead === bytes.length) return bytes;
  } finally {
    await file.close();
  }
}

const characterGalleryDirectories: Readonly<Record<Game, string>> = {
  gi: "gs-character", hsr: "sr-character", zzz: "zzz-character",
};
const characterGalleryExtensions = [".webp", ".png", ".jpg", ".jpeg"];
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function isRaster(data: Buffer) {
  return data.subarray(0, 8).equals(pngSignature) ||
    data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP" ||
    data[0] === 255 && data[1] === 216;
}

type ArtworkAsset = { readonly image: Image; readonly file: Buffer };

async function artworkAsset(file: Buffer | undefined): Promise<ArtworkAsset | undefined> {
  if (!file || !isRaster(file)) return;
  const image = await loadImage(file).catch(() => undefined);
  if (image?.width && image.height) return { image, file };
}

export async function readCharacterGalleryPortrait(game: Game, name: string | readonly string[] | undefined,
  configured?: string, installation?: string): Promise<Image | undefined> {
  return (await characterGalleryPortrait(game, name, maxImageBytes, configured, installation))?.image;
}

async function characterGalleryPortrait(game: Game, name: string | readonly string[] | undefined, maxBytes: number,
  configured = Bun.env.LOTUS_CHARACTER_GALLERY_DIR?.trim(), installation?: string): Promise<ArtworkAsset | undefined> {
  const names = [...new Set(typeof name === "string" ? [name] : name ?? [])]
    .filter(value => value && value !== "." && value !== ".." && !/[\/\\\p{Cc}\p{Cf}]/u.test(value));
  if (!names.length) return;
  const galleryPath = characterGalleryDirectories[game];
  const roots = [{ root: configured || localPanelGalleryRoot(installation), paths: [galleryPath] }];
  if (game === "zzz") {
    const legacyRoot = Bun.env.LOTUS_ZZZ_LEGACY_RESOURCES_DIR?.trim();
    if (legacyRoot) roots.push({ root: legacyRoot, paths: ["images/panel"] });
  }
  const synced = !configured && await readSyncedPanelGalleryRoot(installation);
  if (synced) roots.push({ root: synced, paths: [galleryPath] });
  if (game !== "zzz") {
    const paths = game === "gi" ? ["profile/normal-character", "profile"] : ["profile/normal-character"];
    for (const root of themeDirectories) roots.push({ root, paths });
  }
  for (const { root, paths } of roots) {
    const resolved = await realpath(resolve(root)).catch(() => undefined);
    if (!resolved) continue;
    for (const path of paths) {
      const base = join(resolved, path);
      if (await realpath(base).catch(() => undefined) !== base) continue;
      const candidates: string[] = [];
      for (const name of names) {
        const folder = join(base, name);
        const children = await realpath(folder).catch(() => undefined) === folder
          ? await readdir(folder, { withFileTypes: true }).catch(() => []) : [];
        candidates.push(...characterGalleryExtensions.map(extension => join(base, name + extension)),
          ...children.filter(child => child.isFile() && /\.(?:webp|png|jpe?g)$/iu.test(child.name))
            .map(child => join(folder, child.name)));
      }
      while (candidates.length) {
        const [candidate] = candidates.splice(randomInt(candidates.length), 1);
        const asset = await artworkAsset(await localAsset(candidate!, maxBytes).catch(() => undefined));
        if (asset) return asset;
      }
    }
  }
}

// The original Miao archive declares each of these base portraits valid across elements (`elem: "multi"`).
const travelerPortraits = {
  "10000005": { name: "空", digest: "a8755943c92d8027637b5b9bef17090daf89e838cf544c8307671f8c98ed20b6" },
  "10000007": { name: "荧", digest: "4be7278c87656f59c5860263d6f8b8483a147bd5d04b840b0b7e76ad7b938a54" },
} as const;

async function indexedGenshinPortrait(id: string, maxBytes: number, digest?: string): Promise<ArtworkAsset | undefined> {
  const key = `gi-${id}`;
  const filename = `${key}.webp`;
  for (const theme of portraitDirectories) {
    try {
      const root = await realpath(theme);
      const directory = join(root, "portraits");
      if (await realpath(directory) !== directory) continue;
      const index = await localAsset(join(directory, "index.json"), 1_048_576);
      if (!index || object(JSON.parse(index.toString("utf8")))[key] !== filename) continue;
      const bytes = await localAsset(join(directory, filename), maxBytes);
      if (bytes && (!digest || createHash("sha256").update(bytes).digest("hex") === digest)) {
        const asset = await artworkAsset(bytes);
        if (asset) return asset;
      }
    } catch {
      // Missing original illustrations fall back to the snapshot.
    }
  }
}

async function originalGenshinPortrait(role: RoleDetails, maxBytes = maxImageBytes): Promise<ArtworkAsset | undefined> {
  if (role.game !== "gi" || !/^[1-9]\d*(?:-\d+)?$/u.test(role.id)) return;
  const exact = await indexedGenshinPortrait(role.id, maxBytes);
  const base = role.overview.traveler?.portraitBase;
  if (exact || !base) return exact;
  const { name, digest } = travelerPortraits[base];
  const indexed = await indexedGenshinPortrait(base, maxBytes, digest);
  if (indexed || themeOverride) return indexed;
  const installed = fileURLToPath(new URL("../miao-plugin/resources/meta-gs/character/", import.meta.url));
  const directories = portraitDonor ? [join(portraitDonor, "meta-gs", "character"), installed] : [installed];
  for (const directory of directories) {
    const bytes = await localAsset(join(directory, name, "imgs/splash.webp"), maxBytes).catch(() => undefined);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== digest) continue;
    const asset = await artworkAsset(bytes);
    if (asset) return asset;
  }
}

async function miaoSectionArtwork(role: RoleDetails, qFace: boolean, memosprite: boolean): Promise<{
  card?: Image; face?: Image; talents?: Record<string, unknown>; memosprite?: Readonly<Record<"me" | "mt", Image | undefined>>;
}> {
  const { game, id, overview: { name } } = role;
  if (game === "zzz" || !/^[1-9]\d*$/u.test(id) || !name || name === "." || name === ".." || /[\/\\\p{Cc}\p{Cf}]/u.test(name)) return {};
  const meta = game === "gi" ? "meta-gs" : "meta-sr";
  const installed = fileURLToPath(new URL("../miao-plugin/resources/", import.meta.url));
  const archive = fileURLToPath(new URL("../../backup/plugins/miao-plugin/resources/", import.meta.url));
  const sources = themeOverride ? themeDirectories : [...new Set([...portraitDirectories, installed, archive])];
  for (const configured of sources) {
    const root = await realpath(configured).catch(() => undefined);
    if (!root) continue;
    const base = join(root, meta, "character");
    const directory = join(base, name);
    if (await realpath(directory).catch(() => undefined) !== directory) continue;
    const metadata = await localAsset(join(directory, "data.json"), 1_048_576).catch(() => undefined);
    if (!metadata) continue;
    let record;
    try {
      record = object(JSON.parse(metadata.toString("utf8")));
      if (String(record.id) !== id) continue;
    } catch {
      continue;
    }
    const read = async (folder: string, filename: string) => {
      if (await realpath(folder).catch(() => undefined) !== folder) return;
      return (await artworkAsset(await localAsset(join(folder, filename), maxImageBytes).catch(() => undefined)))?.image;
    };
    const [card, preferred, me, mt] = await Promise.all([
      read(game === "gi" ? join(directory, "imgs") : join(base, "common", "imgs"), "card.webp"),
      qFace ? read(join(directory, "imgs"), "face-q.webp") : undefined,
      memosprite ? read(join(directory, "imgs"), "talent-me.webp") : undefined,
      memosprite ? read(join(directory, "imgs"), "talent-mt.webp") : undefined,
    ]);
    const face = preferred ?? await read(join(directory, "imgs"), "face.webp");
    const talents = game === "hsr" ? object(record.talent) : undefined;
    if (card || face || me || mt || (talents && Object.keys(talents).length)) return { card, face, talents, memosprite: { me, mt } };
  }
  return {};
}

async function galleryAsset(game: Game, path: string | undefined, roots: readonly string[], maxBytes: number): Promise<ArtworkAsset | undefined> {
  if (!isAtlasGalleryPath(path, game)) return;
  // Keep the official supplement available when the exported snapshot changes.
  const digest = challengeArtworkDigests.get(path);
  const bases = digest ? [...roots, ...await Promise.all(themeDirectories.map((directory) =>
    realpath(directory).catch(() => undefined)))] : roots;
  for (const base of bases) {
    if (!base) continue;
    try {
      const resolved = await realpath(join(base, path));
      if (!resolved.startsWith(join(base, "gallery", game) + sep)) continue;
      const bytes = await localAsset(resolved, maxBytes);
      if (!bytes || (digest && createHash("sha256").update(bytes).digest("hex") !== digest)) continue;
      const asset = await artworkAsset(bytes);
      if (asset) return asset;
    } catch {
      // The next source can supply a safe copy when an illustration is missing.
    }
  }
}

async function snapshotGalleryRoots(assetRoot?: string) {
  const root = assetRoot ? await realpath(assetRoot).catch(() => undefined) : undefined;
  return !root ? [] : basename(root) === "data" ? [root, dirname(root)] : [root];
}

async function galleryImages(game: Game, paths: readonly (string | undefined)[], assetRoot: string | undefined) {
  const images = new Map<string, Image>();
  const roots = await snapshotGalleryRoots(assetRoot);
  for (const path of new Set(paths)) {
    if (!path) continue;
    const asset = await galleryAsset(game, path, roots, maxImageBytes);
    if (asset) images.set(path, asset.image);
  }
  return images;
}

export async function readRolePhoto(role: RoleDetails, options: RoleRenderOptions = {}): Promise<Uint8Array | undefined> {
  const maxBytes = Math.min(options.inlineImageByteLimit ?? maxImageBytes, maxImageBytes);
  const { artwork, icon, iconFallback, portraitFallbacks, traveler } = role.overview;
  const names = traveler?.name ?? options.galleryName;
  const illustration = await characterGalleryPortrait(role.game, names, maxBytes) ?? await originalGenshinPortrait(role, maxBytes);
  if (illustration) return illustration.file;
  const roots = await snapshotGalleryRoots(options.assetRoot);
  for (const path of new Set([artwork, ...(portraitFallbacks ?? [])])) {
    if (!path || path === icon || path === iconFallback) continue;
    const asset = await galleryAsset(role.game, path, roots, maxBytes);
    if (asset) return asset.file;
  }
}

async function starRailPartImages(parts: readonly SetPart[]) {
  const images = new Map<string, Image>();
  if (!parts.length) return images;
  for (const theme of themeDirectories) {
    try {
      const root = await realpath(theme);
      const directory = join(root, "relic-parts");
      if (await realpath(directory) !== directory) continue;
      const index = await localAsset(join(directory, "index.json"), 1_048_576);
      if (!index) continue;
      const references = object(JSON.parse(index.toString("utf8")));
      for (const part of parts) {
        if (images.has(part.id) || !/^[1-9]\d*$/u.test(part.id)) continue;
        const reference = object(references[`sr-${part.id}`]);
        const file = label(reference.file);
        if (label(reference.name) !== part.name || !/^sr-[1-9]\d*-[1-6]\.webp$/u.test(file)) continue;
        try {
          const bytes = await localAsset(join(directory, file), maxImageBytes);
          if (bytes) images.set(part.id, await loadImage(bytes));
        } catch {
          // The named snapshot part remains available when its original image is absent.
        }
      }
    } catch {
      // The operator may supply the original background without the optional part archive.
    }
  }
  return images;
}

function measurePage(head: number, panels: readonly Block[][], trailingGap: boolean) {
  const heights = panels.map((blocks) => blocks.reduce((sum, { height }) => sum + height, 0));
  const gap = Math.max(0, heights.length - (trailingGap ? 0 : 1)) * 16;
  return { heights, height: Math.max(460, head + heights.reduce((sum, panelHeight) => sum + panelHeight, 0) + gap + footer) };
}

export async function renderLookupNotice(query: string, message: string, game: Game | undefined, options: RoleRenderOptions = {}) {
  const [background] = await Promise.all([themeImage("bg/bg-sr.webp"), themeFonts ??= loadThemeFonts()]);
  const { wrap, text } = makeLayout();
  const title = wrap(query, 620, 33);
  const [page] = await renderAtlasPages([{ section: "图鉴资料", panels: [[text(message)]] }], title,
    game, "", undefined, background, options, 152);
  return page!;
}

function roleSectionStyle(role: RoleDetails, wrap: ReturnType<typeof makeLayout>["wrap"],
  background: Image | undefined, portrait: Image | undefined, icon: Image | undefined, panelBackground: Image | undefined): RoleSectionStyle {
  const { facts, sectionStats, description, name } = role.overview;
  const title = facts.find(({ label }) => label === "称号")?.value;
  const names = wrap(title ? `${title}·${name}` : name, 546, 38);
  const intro = description ? wrap(description.replaceAll("\\n", "\n"), 536, 20) : [];
  const statsTop = Math.max(209, 91 + names.length * 44 + intro.length * 28);
  return {
    headerHeight: statsTop + 150,
    panelBackground,
    paintHeader(ctx, section, page) {
      const headerEnd = statsTop + 125;
      ctx.fillStyle = "#272f43";
      ctx.fillRect(0, 0, width, headerEnd);
      if (background) {
        const scale = Math.max(width / background.width, headerEnd / background.height);
        const sourceWidth = width / scale;
        const sourceHeight = headerEnd / scale;
        ctx.drawImage(background, (background.width - sourceWidth) / 2, (background.height - sourceHeight) / 2,
          sourceWidth, sourceHeight, 0, 0, width, headerEnd);
      } else if (portrait) {
        contain(ctx, portrait, 428, 0, 372, headerEnd);
      }
      const shade = ctx.createLinearGradient(0, 0, width, 0);
      shade.addColorStop(0, "rgba(9,15,27,0.75)");
      shade.addColorStop(1, "rgba(9,15,27,0.25)");
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, width, headerEnd);
      if (icon) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(116, 100, 62, 0, 2 * Math.PI);
        ctx.clip();
        ctx.fillStyle = "#272f43";
        ctx.fillRect(54, 38, 124, 124);
        contain(ctx, icon, 54, 38, 124, 124);
        ctx.restore();
        ctx.strokeStyle = "#f0efe0";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(116, 100, 62, 0, 2 * Math.PI);
        ctx.stroke();
      }
      paintLines(ctx, names, 225, 29, 38, 44, white);
      paintLines(ctx, intro, 225, 43 + names.length * 44, 20, 28, white);
      paintLines(ctx, [`${gameNames[role.game]} · ${section} · ${page}`], 225, statsTop - 41, 16, 22, gold);
      rounded(ctx, 16, statsTop, width - 32, 104, 15, "rgba(245,245,245,0.87)");
      const statTitle = sectionStats ? `${sectionStats.level}级基础数据` : "基础数据";
      rounded(ctx, 30, statsTop - 19, 172, 32, 8, "#272f43");
      paintLines(ctx, [statTitle], 44, statsTop - 14, 19, 24, white);
      const rows = sectionStats?.rows;
      if (!rows?.length) {
        paintLines(ctx, ["暂无详细数据"], 44, statsTop + 35, 20, 28, "#292e3a");
      } else {
        const cell = (width - 32) / rows.length;
        for (const [i, { value, label }] of rows.entries()) {
          const x = 44 + i * cell;
          paintLines(ctx, [value], x, statsTop + 24, 34, 44, "#1e1f20");
          paintLines(ctx, [label], x, statsTop + 66, 18, 24, "#626c73");
        }
      }
    },
  };
}

function sectionSkillLevels(card: RoleSkillCard, talents?: Record<string, unknown>, source?: { name: string; rowPrefix: string }) {
  const levels = card.sectionLevels ?? card.levels ?? [];
  if (!talents || !card.sectionParameters?.length) return levels;
  const sources = Object.values(talents).map(object).filter(({ name }) => label(name) === (source?.name ?? card.name));
  if (sources.length !== 1) return levels;
  const prefix = source?.rowPrefix;
  const oldRows = Object.values(object(sources[0]!.tables)).map(object).filter(({ name }) =>
    prefix ? label(name).startsWith(prefix) : !card.linkedEffects?.length || !/^「[^」]+」之诗•/u.test(label(name)));
  const labels = new Map<string, string>();
  for (const { label: row, values } of card.sectionParameters) {
    const matches = oldRows.filter(({ values: old }) => Array.isArray(old) && values.every(({ level, value }) => {
      const previous = old[level - 1];
      return typeof previous === "number" && Math.abs(previous - value) <= 1e-8;
    }));
    const text = matches.length === 1 ? label(matches[0]!.name).slice(prefix ? prefix.length : 0) : "";
    if (text) labels.set(row, text);
  }
  return levels.map((level) => ({ ...level, details: level.details.map((item) =>
    ({ ...item, label: item.label ? labels.get(item.label) ?? item.label : undefined })) }));
}

export async function renderRoleBook(role: RoleDetails, options: RoleRenderOptions = {}, section?: RoleSection) {
  const sourceGroups = section === "skills" ? role.sectionSkills ?? role.skills : role.skills;
  const skillGroups = section === "ranks" ? [] : sourceGroups.flatMap(({ title, cards }) => {
    const available = section ? cards.filter(({ omitFromSection }) => !omitFromSection) : cards;
    return available.length ? [{ title, cards: available }] : [];
  });
  const ranks = section === "skills" ? [] : role.ranks;
  const materials = section ? [] : role.materials.filter(({ items }) => items.length);
  if (section && !skillGroups.length && !ranks.length) return [];

  const property = role.overview.facts.find(({ label }) => label === "属性") ??
    role.overview.facts.find(({ label }) => label === "神之眼" || label === "元素");
  const element = role.game === "gi" ? role.overview.element : undefined;
  const backdrop = element ?? backgrounds.find(([pattern]) => pattern.test(property?.value ?? ""))?.[1] ?? "sr";
  const [images, background, texture, galleryPortrait, originalPortrait, sectionArt, sectionBackdrop] = await Promise.all([
    galleryImages(role.game, [role.overview.icon, role.overview.iconFallback, role.overview.artwork,
      ...(role.overview.portraitFallbacks ?? []),
      ...skillGroups.flatMap(({ cards }) => cards.map(({ artwork }) => artwork)), ...ranks.map(({ artwork }) => artwork),
      ...materials.flatMap(({ items }) => items.map(({ artwork }) => artwork))], options.assetRoot),
    themeImage(`bg/bg-${backdrop}.webp`), themeImage("card-bg.png"),
    readCharacterGalleryPortrait(role.game, role.overview.traveler?.name ?? options.galleryName),
    originalGenshinPortrait(role),
    section ? miaoSectionArtwork(role, options.qFace !== false,
      skillGroups.some(({ cards }) => cards.some(card => card.memospriteIcon))) : undefined,
    section ? themeImage(`bg/talent-${backdrop}.webp`) : undefined,
    themeFonts ??= loadThemeFonts(),
  ]);
  const image = (path?: string) => path === undefined ? undefined : images.get(path);
  const layout = makeLayout(texture, sectionBackdrop);
  const { wrap, heading, text, statRow, material } = layout;
  const details = ({ label, text: value }: RoleText) => text(label ? `${label}　${value}` : value);
  const icon = image(role.overview.icon) ?? image(role.overview.iconFallback);
  const snapshotPortrait = image(role.overview.artwork) ??
    role.overview.portraitFallbacks?.map(image).find((candidate) => candidate !== undefined) ?? icon;
  // The Genshin icon fields hold avatars. The Zenless source also stores full-body art in its icon fields.
  const portrait = galleryPortrait ?? originalPortrait?.image ??
    (role.game === "gi" && snapshotPortrait === icon ? undefined : snapshotPortrait);
  const title = wrap(role.overview.name, icon ? 620 : contentWidth, 33);
  const overview: Block[] = [];
  if (portrait) overview.push({ height: 300, paint: (ctx, top) => contain(ctx, portrait, margin + 20, top + 8, contentWidth, 284) });
  if (role.overview.description) overview.push(text(role.overview.description));
  const facts = role.overview.facts.map(({ label, value }) => `${label}：${value}`);
  if (role.overview.rarity) facts.unshift(`稀有度：${role.overview.rarity}`);
  if (facts.length) overview.push(text(facts.join(" · "), gold));
  const stats = role.overview.stats ?? [];
  for (let start = 0; start < stats.length; start += 3) {
    overview.push(statRow(stats.slice(start, start + 3)));
  }

  const pages: Page[] = section ? [] : [{ section: "角色总览", panels: overview.length ? [overview] : [] }];
  const skills = skillGroups.flatMap(({ title, cards }) => [
    [heading(title, undefined, true)],
    ...cards.flatMap((card) => {
      const description = section ? card.sectionDescription ?? card.description : card.description;
      const levels = section ? sectionSkillLevels(card, sectionArt?.talents) : card.levels ?? [];
      const originalIcon = card.memospriteIcon ? sectionArt?.memosprite?.[card.memospriteIcon] : undefined;
      const main = [heading(card.name, originalIcon ?? image(card.artwork)), ...(description ? [text(description)] : []),
        ...card.details.map(details), ...layout.levelBlocks(levels)];
      if (section && card.sectionVariants?.length) {
        if (card.sectionVariantTitle) main.push(heading(card.sectionVariantTitle, undefined, true));
        for (const variant of card.sectionVariants) {
          const body = variant.sectionDescription ?? variant.description;
          const source = card.sectionVariantTitle ? { name: card.sectionVariantTitle, rowPrefix: variant.name + "·" } : undefined;
          main.push(heading(variant.name, undefined, true), ...(body ? [text(body)] : []),
            ...variant.details.map(details), ...layout.levelBlocks(sectionSkillLevels(variant, sectionArt?.talents, source)));
        }
      }
      const effects = (section ? card.linkedEffects ?? [] : []).map(effect => {
        const body = effect.sectionDescription ?? effect.description;
        const source = { name: card.name, rowPrefix: effect.name.replace(/^献予/u, "") + "•" };
        return [heading(effect.name, undefined, true), ...(body ? [text(body)] : []),
          ...layout.levelBlocks(sectionSkillLevels(effect, sectionArt?.talents, source))];
      });
      return [main, ...effects];
    }),
  ]);
  if (skills.length) pages.push({ section: { gi: "技能与天赋", hsr: "技能与行迹", zzz: "技能与核心能力" }[role.game], panels: skills });
  if (ranks.length) pages.push({ section: { gi: "命座", hsr: "星魂", zzz: "影画" }[role.game], panels: ranks.map((rank) => [
    heading(`${rank.rank} · ${rank.name}`, image(rank.artwork)),
    ...(rank.description ? [text(rank.description)] : []), ...(rank.story ? [text(rank.story, muted, 17)] : []),
  ]) });
  if (materials.length) pages.push({ section: "养成材料", panels: materials.map(({ title, items, cost }) => [
    heading(title, undefined, true), ...(cost === undefined ? [] : [text(`消耗　${cost}`, gold)]),
    ...items.map((item) => material(item.name ?? (item.id ? `待核对材料（${item.id}）` : "材料"), item.count, image(item.artwork))),
  ]) });

  const style = section ? roleSectionStyle(role, wrap, sectionArt?.card, portrait, sectionArt?.face ?? icon, background) : undefined;
  return renderAtlasPages(pages, title, role.game, role.version, icon, background, options, undefined, true, style);
}

export async function renderWeapon(weapon: WeaponDetails, options: RoleRenderOptions = {}) {
  const { game } = weapon;
  const [images, background, texture] = await Promise.all([
    galleryImages(game, [weapon.artwork], options.assetRoot), themeImage("bg/bg-sr.webp"), themeImage("card-bg.png"),
    themeFonts ??= loadThemeFonts(),
  ]);
  const { wrap, heading, text, statRow } = makeLayout(texture);
  const icon = weapon.artwork ? images.get(weapon.artwork) : undefined;
  const title = wrap(weapon.name, icon ? 620 : contentWidth, 33);
  const overview = [text(weapon.description ?? "")];
  for (let start = 0; start < weapon.stats.length; start += 3) {
    overview.push(statRow(weapon.stats.slice(start, start + 3)));
  }
  const section = { gi: "武器", hsr: "光锥", zzz: "音擎" }[game];
  const grade = { gi: "精", hsr: "叠影", zzz: "改装等级 " }[game];
  const cards = weapon.refinements.map(({ rank, name, description }) => [
    heading(name ? `${grade}${rank} · ${name}` : `${grade}${rank}`), ...(description ? [text(description)] : []),
  ]);
  // The original equipment card joins its first refinement to the overview, then rounds each remaining card.
  const panels = [[...overview, ...(cards.shift() ?? [])], ...cards].filter((panel) => panel.length);
  if (weapon.story) panels.push([heading("武器故事"), text(weapon.story)]);
  const [page] = await renderAtlasPages([{ section, panels }], title, game, weapon.version, icon, background, options);
  return page!;
}

export async function renderAchievementCategory(category: AchievementCategory, artwork?: string, options: RoleRenderOptions = {}) {
  const { game, name, version } = category;
  const [images, background] = await Promise.all([
    galleryImages(game, [artwork], options.assetRoot), themeImage("bg/bg-sr.webp"),
    themeFonts ??= loadThemeFonts(),
  ]);
  const icon = artwork ? images.get(artwork) : undefined;
  const { wrap, text } = makeLayout();
  const [page] = await renderAtlasPages([{ section: "成就", panels: [[text("")]], trailingGap: false }],
    wrap(name, 620, 33), game, version, icon, background, options, 152);
  return page!;
}

export async function renderGenshinCard(card: GenshinCardDetails, options: RoleRenderOptions = {}) {
  const sourceBackground = backgrounds.find(([pattern]) => pattern.test(card.tags.join("、")))?.[1] ?? "sr";
  const [images, background, texture] = await Promise.all([
    galleryImages("gi", [card.artwork], options.assetRoot),
    themeImage(`bg/bg-${sourceBackground}.webp`),
    themeImage("card-bg.png"),
    themeFonts ??= loadThemeFonts(),
  ]);
  const { wrap, heading, text } = makeLayout(texture);
  const art = card.artwork ? images.get(card.artwork) : undefined;
  const meta = [`ID ${card.id}`, card.type, card.hp === undefined ? "" : `生命 ${card.hp}`, card.cost && `费用 ${card.cost}`, ...card.tags].filter(Boolean);
  const panels: Block[][] = [[text(meta.join(" · "))]];
  if (card.description) panels[0]!.push(heading("简介"), text(card.description));
  if (card.source) panels[0]!.push(heading("获得方式"), text(card.source));
  for (const skill of card.skills) {
    panels.push([heading(skill.name), ...(skill.cost ? [text(skill.cost)] : []), text(skill.description)]);
  }
  const [page] = await renderAtlasPages([{ section: "七圣召唤", panels }], wrap(card.name, 620, 33),
    "gi", card.version, art, background, options);
  return page!;
}

export async function renderMonster(monster: MonsterDetails, options: RoleRenderOptions = {}) {
  const { game, artwork, description, name, version } = monster;
  const [images, background, texture] = await Promise.all([
    galleryImages(game, [artwork], options.assetRoot), themeImage("bg/bg-sr.webp"), themeImage("card-bg.png"),
    themeFonts ??= loadThemeFonts(),
  ]);
  const { wrap, heading, text } = makeLayout(texture);
  const icon = artwork ? images.get(artwork) : undefined;
  // The original generic item card shows its overview and repeats it below the introduction heading.
  const panels = [[text(description), heading("简介"), text(description)]];
  const [page] = await renderAtlasPages([{ section: "敌人", panels }], wrap(name, 620, 33), game, version, icon, background, options, 152);
  return page!;
}

export async function renderOnslaught(onslaught: OnslaughtDetails, options: RoleRenderOptions = {}) {
  const { name, version, artwork, window, rules, enemies } = onslaught;
  const [images, background, texture] = await Promise.all([
    galleryImages("gi", [artwork, ...enemies.map((enemy) => enemy.artwork)], options.assetRoot),
    themeImage("bg/bg-sr.webp"), themeImage("card-bg.png"), themeFonts ??= loadThemeFonts(),
  ]);
  const { wrap, text, heading } = makeLayout(texture);
  const icon = artwork ? images.get(artwork) : undefined;
  const period = window ? `${window.begin.slice(0, 10)} - ${window.end.slice(0, 10)}` : "";
  const title = [`${version.split(".", 2).join(".")} 幽境危战 N5/6`.trim(), period,
    window?.from === "export" ? "导出时间（轮换待核对）" : ""].filter(Boolean).join(" · ");
  const blocks = [text(title), ...rules.flatMap(({ difficulty, description }) => [heading(difficulty), text(description)])];
  for (const enemy of enemies) {
    const [first] = enemy.variants;
    if (!first) continue;
    blocks.push(heading(enemy.name, enemy.artwork ? images.get(enemy.artwork) : undefined), text(`Lv${first.level}`));
    blocks.push(text(enemy.variants.map(({ difficulty, level }) => `${difficulty}：Lv${level}`).join(" · ")));
    for (const { difficulty, description } of enemy.variants) {
      if (description) blocks.push(heading(`${difficulty}说明`), text(description));
    }
    if (enemy.mechanics) blocks.push(text(enemy.mechanics));
  }
  const [page] = await renderAtlasPages([{ section: "挑战图鉴", panels: [blocks], trailingGap: false }], wrap(name, 620, 33),
    "gi", version, icon, background, options, 152);
  return page!;
}

export async function renderTheater(theater: TheaterDetails, options: RoleRenderOptions = {}) {
  const { name, version, artwork, window, difficulty, minLevel, maxAct, elements, groups, acts } = theater;
  const cards = [...elements, ...groups.flatMap((group) => group.cards), ...acts.flatMap((act) => act.enemies)];
  const [images, background, texture] = await Promise.all([
    galleryImages("gi", [artwork, ...cards.map((card) => card.artwork)], options.assetRoot),
    themeImage("bg/bg-sr.webp"), themeImage("card-bg.png"), themeFonts ??= loadThemeFonts(),
  ]);
  const { wrap, text, heading } = makeLayout(texture);
  const period = window ? `${window.begin.slice(0, 10)} - ${window.end.slice(0, 10)}` : "";
  const provenance = window?.from === "export" ? "导出时间（轮换待核对）" : window ? "" : "轮换时间待核对";
  const overview = [version.split(".", 2).join("."), difficulty, period, provenance,
    minLevel ? `最低角色等级 Lv${minLevel}` : "最低角色等级待核对",
    maxAct ? `首领最大幕次 ${maxAct}` : "首领最大幕次待核对"].filter(Boolean).join(" · ");
  const blocks = [text(overview)];
  const addCards = (items: readonly (typeof cards)[number][]) => {
    for (const { name, artwork, description } of items) {
      blocks.push(heading(name, artwork ? images.get(artwork) : undefined));
      if (description) blocks.push(text(description));
    }
  };
  if (elements.length) {
    blocks.push(heading("限定元素"));
    addCards(elements);
  }
  for (const group of groups) {
    blocks.push(heading(group.name));
    addCards(group.cards);
  }
  for (const act of acts) {
    blocks.push(heading(act.name));
    if (act.subtitle) blocks.push(text(act.subtitle));
    if (act.description) blocks.push(text(act.description));
    addCards(act.enemies);
  }
  const icon = artwork ? images.get(artwork) : undefined;
  const [page] = await renderAtlasPages([{ section: "挑战图鉴", panels: [blocks], trailingGap: false }], wrap(name, 620, 33),
    "gi", version, icon, background, options, 152);
  return page!;
}

export async function renderAbyss(abyss: AbyssDetails, options: RoleRenderOptions = {}) {
  const { name, version, artwork, window, scheduleConflict, effects, rooms } = abyss;
  const enemies = rooms.flatMap((room) => room.sides.flatMap((side) => side.enemies));
  const [images, background, texture] = await Promise.all([
    galleryImages("gi", [artwork, ...enemies.map((enemy) => enemy.artwork)], options.assetRoot),
    themeImage("bg/bg-sr.webp"), themeImage("card-bg.png"), themeFonts ??= loadThemeFonts(),
  ]);
  const { wrap, text, heading } = makeLayout(texture);
  const range = window ? `${window.begin.slice(0, 10)} - ${window.end.slice(0, 10)}` : "";
  const period = scheduleConflict ? `快照时间 ${range}（与实装公告冲突，待核对）`
    : window?.from === "export" ? `导出时间 ${range}（轮换待核对）`
      : range || "轮换时间待核对";
  const blocks = [text(period), heading("环境与全局效果")];
  for (const { title, description } of effects) blocks.push(heading(title), text(description));
  const hpFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
  for (const room of rooms) {
    blocks.push(heading(room.name), text([room.level ? `Lv${room.level}` : "", room.goal].filter(Boolean).join(" · ")));
    for (const side of room.sides) {
      blocks.push(heading(side.name));
      if (!side.enemies.length) blocks.push(text("阵容待核对"));
      for (const enemy of side.enemies) {
        const name = enemy.count && enemy.count > 1 ? `${enemy.name} ×${enemy.count}` : enemy.name;
        blocks.push(heading(name, enemy.artwork ? images.get(enemy.artwork) : undefined));
        if (enemy.hp) blocks.push(text(`快照生命值 ${hpFormat.format(enemy.hp)}`));
        if (enemy.description) blocks.push(text(enemy.description));
      }
    }
  }
  const icon = artwork ? images.get(artwork) : undefined;
  const [page] = await renderAtlasPages([{ section: "挑战图鉴", panels: [blocks], trailingGap: false }], wrap(name, 620, 33),
    "gi", version, icon, background, options, 152);
  return page!;
}

export async function renderStarrailChallenge(challenge: StarrailChallengeDetails, options: RoleRenderOptions = {}) {
  const { name, version, artwork, window, effects, optional, rooms } = challenge;
  const enemies = rooms.flatMap((room) => room.sides.flatMap((side) => side.enemies));
  const [images, background, texture] = await Promise.all([
    galleryImages("hsr", [artwork, ...enemies.map((enemy) => enemy.artwork)], options.assetRoot),
    themeImage("bg/bg-sr.webp"), themeImage("card-bg.png"), themeFonts ??= loadThemeFonts(),
  ]);
  const { wrap, text, heading } = makeLayout(texture);
  const range = window ? `${window.begin.slice(0, 10)} - ${window.end.slice(0, 10)}` : "";
  const period = window?.from === "export" ? `导出时间 ${range}（轮换待核对）` : range || "轮换时间待核对";
  const intro = [text(period)];
  if (effects.length || rooms.every(({ description }) => !description)) {
    intro.push(heading("环境与全局效果"));
    if (!effects.length) intro.push(text("增益说明待核对"));
    for (const effect of effects) {
      if (effect.name) intro.push(heading(effect.name));
      intro.push(text(effect.description || "增益说明待核对"));
    }
  }
  const addOptional = (blocks: Block[], buffs: typeof optional) => {
    if (!buffs.length) return;
    blocks.push(heading("可选增益"));
    for (const buff of buffs) blocks.push(heading(buff.name), text(buff.description || "增益说明待核对"));
  };
  addOptional(intro, optional);
  const continuation = [intro];
  for (const room of rooms) {
    const blocks: Block[] = [];
    const weaknesses = room.sides.flatMap((side) => side.weaknesses.length
      ? [`${side.name === "星启模式" || side.name === "敌人" ? "" : side.name}弱点 ${side.weaknesses.join(" / ")}`] : []);
    blocks.push(heading(room.name));
    if (weaknesses.length || room.goals.length) blocks.push(text([...weaknesses, ...room.goals].join(" · ")));
    if (room.description) blocks.push(text(room.description));
    if (room.optional) addOptional(blocks, room.optional);
    for (const side of room.sides) {
      blocks.push(heading(side.name));
      if (!side.enemies.length) blocks.push(text("阵容待核对"));
      for (const enemy of side.enemies) {
        blocks.push(heading(enemy.name, enemy.artwork ? images.get(enemy.artwork) : undefined));
        if (enemy.level) blocks.push(text(`Lv${enemy.level}`));
        if (enemy.description) blocks.push(text(enemy.description));
      }
    }
    continuation.push(blocks);
  }
  const icon = artwork ? images.get(artwork) : undefined;
  return renderAtlasPages([{ section: "挑战图鉴", panels: [continuation.flat()], trailingGap: false, continuation }], wrap(name, 620, 33),
    "hsr", version, icon, background, options, 152);
}

export async function renderShiyu(shiyu: ShiyuDetails, options: RoleRenderOptions = {}) {
  const { name, version, artwork, window, forecast, effects, defenses } = shiyu;
  const lines = defenses.flatMap((defense) => [defense, ...defense.challenges]);
  const enemies = lines.flatMap((line) => line.rooms.flatMap((room) => room.enemies));
  const [images, background, texture] = await Promise.all([
    galleryImages("zzz", [artwork, ...enemies.map((enemy) => enemy.artwork)], options.assetRoot),
    themeImage("bg/bg-sr.webp"), themeImage("card-bg.png"), themeFonts ??= loadThemeFonts(),
  ]);
  const { wrap, text, heading } = makeLayout(texture);
  const range = window ? `${window.begin.slice(0, 10)} - ${window.end.slice(0, 10)}` : "";
  const period = forecast ? `快照预计 · ${range}`
    : window?.from === "export" ? `导出时间 ${range}（轮换待核对）`
      : range || "起止时间待核对";
  const intro = [text(period)];
  if (effects.length) {
    intro.push(heading("环境与全局效果"));
    for (const effect of effects) intro.push(heading(effect.name), text(effect.description));
  }
  const continuation = [intro];
  for (const line of lines) {
    const effects = line.rooms.length && line.effects.length ? line.effects.join(" / ") : "";
    const blocks = [heading(line.name), text([line.level ? `Lv${line.level}` : "", line.goals, effects].filter(Boolean).join(" · "))];
    if (!line.rooms.length && !line.challenges.length) blocks.push(text("阵容待核对"));
    blocks.push(...zzzRoomBlocks(line.rooms, { heading, text }, images));
    continuation.push(blocks);
  }
  const icon = artwork ? images.get(artwork) : undefined;
  return renderAtlasPages([{ section: "挑战图鉴", panels: [continuation.flat()], trailingGap: false, continuation }], wrap(name, 620, 33),
    "zzz", version, icon, background, options, 152);
}

function zzzRoomBlocks(rooms: readonly ZzzChallengeRoom[],
  { heading, text }: Pick<ReturnType<typeof makeLayout>, "heading" | "text">, images: ReadonlyMap<string, Image>): Block[] {
  const blocks: Block[] = [];
  const hpFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
  for (const room of rooms) {
    if (room.name) blocks.push(heading(room.name));
    const facts = [room.level ? `Lv${room.level}` : "",
      room.weaknesses.length ? `弱点 ${room.weaknesses.join(" / ")}` : "",
      room.resistances.length ? `抗性 ${room.resistances.join(" / ")}` : ""].filter(Boolean);
    if (facts.length) blocks.push(text(facts.join(" · ")));
    if (!room.enemies.length) blocks.push(text("阵容待核对"));
    for (const enemy of room.enemies) {
      blocks.push(heading(enemy.name, enemy.artwork ? images.get(enemy.artwork) : undefined));
      if (enemy.hp) blocks.push(text(`快照生命值 ${hpFormat.format(enemy.hp)}`));
      if (enemy.description) blocks.push(text(enemy.description));
    }
  }
  return blocks;
}

export async function renderDeadlyAssault(assault: DeadlyAssaultDetails, options: RoleRenderOptions = {}) {
  const { name, version, artwork, window, commonOptional, divisions } = assault;
  const encounters = divisions.flatMap((division) => division.encounters);
  const enemies = encounters.flatMap((encounter) => encounter.rooms.flatMap((room) => room.enemies));
  const [images, background, texture] = await Promise.all([
    galleryImages("zzz", [artwork, ...enemies.map((enemy) => enemy.artwork)], options.assetRoot),
    themeImage("bg/bg-sr.webp"), themeImage("card-bg.png"), themeFonts ??= loadThemeFonts(),
  ]);
  const { wrap, text, heading } = makeLayout(texture);
  const range = window ? `${window.begin.slice(0, 10)} - ${window.end.slice(0, 10)}` : "";
  const period = window?.from === "export" ? `导出时间 ${range}（轮换待核对）` : range || "轮换时间待核对";
  const blocks = [text(period)];
  const addOptional = (effects: typeof commonOptional) => {
    if (!effects.length) return;
    blocks.push(heading("可选增益"));
    for (const { name, description } of effects) {
      if (name) blocks.push(heading(name));
      blocks.push(text(description));
    }
  };
  addOptional(commonOptional);
  for (const division of divisions) {
    blocks.push(heading(division.name));
    for (const encounter of division.encounters) {
      const meta = [encounter.level ? `Lv${encounter.level}` : "", encounter.goals].filter(Boolean).join(" · ");
      blocks.push(heading(encounter.name), text(meta));
      for (const { name, description } of encounter.mechanics) {
        if (name) blocks.push(heading(name));
        blocks.push(text(description));
      }
      if (!commonOptional.length) addOptional(encounter.optional);
      if (!encounter.rooms.length) blocks.push(text("阵容待核对"));
      blocks.push(...zzzRoomBlocks(encounter.rooms, { heading, text }, images));
    }
  }
  const icon = artwork ? images.get(artwork) : undefined;
  const [page] = await renderAtlasPages([{ section: "挑战图鉴", panels: [blocks], trailingGap: false }], wrap(name, 620, 33),
    "zzz", version, icon, background, options, 152);
  return page!;
}

export async function renderSet(set: SetDetails, options: RoleRenderOptions = {}) {
  const [images, background, texture] = await Promise.all([
    galleryImages(set.game, [set.artwork, ...set.parts.map(({ artwork }) => artwork)], options.assetRoot),
    themeImage("bg/bg-sr.webp"), themeImage("card-bg.png"), themeFonts ??= loadThemeFonts(),
  ]);
  const themed = set.game === "hsr" ? await starRailPartImages(set.parts.filter(({ artwork }) => !artwork || !images.has(artwork))) : undefined;
  const { wrap, heading, material, text } = makeLayout(texture);
  const icon = set.artwork ? images.get(set.artwork) : undefined;
  const title = wrap(set.name, icon ? 620 : contentWidth, 33);
  const pages: Page[] = [];
  if (set.effects.length) pages.push({ section: "套装效果", panels: set.effects.map((effect) => [heading(effect.title), text(effect.text)]) });
  if (set.parts.length) pages.push({ section: "套装部件", trailingGap: false, panels: [set.parts.map((part) =>
    material(part.name, undefined, (part.artwork ? images.get(part.artwork) : undefined) ?? themed?.get(part.id)))] });
  if (set.story) pages.push({ section: "套装故事", panels: [[text(set.story)]], trailingGap: false });
  return renderAtlasPages(pages, title, set.game, set.version, icon, background, options);
}

export async function renderBangboo(bangboo: BangbooDetails, options: RoleRenderOptions = {}) {
  const [images, background, texture] = await Promise.all([
    galleryImages("zzz", [bangboo.artwork, ...bangboo.skills.map(({ artwork }) => artwork)], options.assetRoot),
    themeImage("bg/bg-sr.webp"), themeImage("card-bg.png"), themeFonts ??= loadThemeFonts(),
  ]);
  const { wrap, heading, text, statRow, row } = makeLayout(texture);
  const icon = bangboo.artwork ? images.get(bangboo.artwork) : undefined;
  const title = wrap(bangboo.name, 620, 33);
  const overview = [text(bangboo.description)];
  for (let start = 0; start < bangboo.stats.length; start += 3) {
    overview.push(statRow(bangboo.stats.slice(start, start + 3)));
  }
  const pages: Page[] = [{ section: "邦布总览", panels: [overview], trailingGap: false }];
  if (bangboo.skills.length) {
    const panels = bangboo.skills.map(({ name, type, description, artwork, levels, rows }) => {
      const panel = [heading(name, artwork ? images.get(artwork) : undefined, false, type)];
      if (description) panel.push(text(description));
      if (!rows.length) return panel;
      panel.push(text("等级数值", gold, 17, 29));
      for (let start = 0; start < levels.length; start += 4) {
        const columns = levels.slice(start, start + 4).map((level) => `Lv${level}`);
        const labelWidth = 280;
        const widths = [labelWidth, ...columns.map(() => (contentWidth - labelWidth) / columns.length)];
        panel.push(row(["项目", ...columns], widths, true));
        for (const item of rows) {
          panel.push(row([item.label, ...item.values.slice(start, start + columns.length)], widths));
        }
        panel.push({ height: 12, paint() {} });
      }
      return panel;
    });
    pages.push({ section: "邦布技能", panels });
  }
  return renderAtlasPages(pages, title, "zzz", bangboo.version, icon, background, options, 152);
}

async function renderAtlasPages(pages: Page[], title: string[], gameId: Game | undefined, version: string, icon: Image | undefined,
  background: Image | undefined, { mode = "auto", scale = 4, inlineImageByteLimit }: RoleRenderOptions, titleX = icon ? 152 : margin + 20,
  allowPanelContinuation = false, style?: RoleSectionStyle) {
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new RangeError("图鉴缩放比例须在 1 至 4 之间。");
  const low = nativeImageRasterScale() === 1;
  const pageScale = low ? 1 : scale;
  const game = gameId ? gameNames[gameId] : "全部游戏";
  const head = style?.headerHeight ?? Math.max(header, 118 + title.length * 39);
  const renderPage = ({ panels, trailingGap }: Page, section: string, page: string, zoom: number, allowHalfScale = false) => {
    const { heights, height } = measurePage(head, panels, trailingGap !== false);
    const paint = (ctx: Context) => {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.fillStyle = "#252c40";
      ctx.fillRect(0, 0, width, height);
      if (background) ctx.drawImage(background, 0, 0, width, height);

      if (style) {
        style.paintHeader(ctx, section, page);
      } else {
        rounded(ctx, margin, 12, inner, head - 32, 12, "rgba(15,18,29,0.52)");
        if (icon) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(84, 79, 51, 0, Math.PI * 2);
          ctx.clip();
          contain(ctx, icon, 33, 28, 102, 102);
          ctx.restore();
          ctx.strokeStyle = gold;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(84, 79, 52, 0, Math.PI * 2);
          ctx.stroke();
        }
        paintLines(ctx, title, titleX, 30, 33, 39, white);
        paintLines(ctx, [`${game} · ${section} · ${page}`], titleX + 2, 35 + title.length * 39, 18, 29, gold);
        paintLines(ctx, [version ? `资料版本 ${version}` : "角色与装备资料"], titleX + 2, 69 + title.length * 39, 14, 29, muted);
      }

      let y = head;
      for (const [panel, blocks] of panels.entries()) {
        const panelHeight = heights[panel]!;
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(margin, y, inner, panelHeight, style ? 23 : 10);
        ctx.clip();
        if (style?.panelBackground) ctx.drawImage(style.panelBackground, margin, y, inner, panelHeight);
        ctx.fillStyle = "rgba(15,20,31,0.58)";
        ctx.fillRect(margin, y, inner, panelHeight);
        for (const block of blocks) {
          block.paint(ctx, y);
          y += block.height;
        }
        ctx.restore();
        y += 16;
      }
      paintLines(ctx, [`Lotus-Yunzai · 图鉴 · ${page}`], margin, height - 37, 14, 21, muted);
    };
    return renderPng(Math.floor(width * zoom), Math.floor(height * zoom), (ctx) => {
      ctx.scale(zoom, zoom);
      paint(ctx);
    }, mode, { allowHalfScale, renderScale: zoom });
  };
  const fits = (image: { readonly png: Uint8Array }) =>
    inlineImageByteLimit === undefined || image.png.byteLength <= inlineImageByteLimit;
  const renderWithinCodec = (...args: Parameters<typeof renderPage>) => renderPage(...args).catch(error => {
    if (error instanceof ImageSizeLimitError) return error;
    throw error;
  });
  const output = [];
  for (const [index, layout] of pages.entries()) {
    const { section, continuation } = layout;
    const pageNumber = `${index + 1}/${pages.length}`;
    let image = await renderWithinCodec(layout, section, pageNumber, pageScale, pageScale === 4);
    if (!(image instanceof ImageSizeLimitError) && !fits(image) && pageScale === 4 && image.reducedScaleReason === undefined) {
      const smaller = await renderWithinCodec(layout, section, pageNumber, 2);
      image = smaller instanceof ImageSizeLimitError ? smaller :
        { ...smaller, reducedScaleReason: "四倍图超过当前聊天的单图大小上限。" };
    }
    if (!(image instanceof ImageSizeLimitError) && fits(image)) {
      output.push({ section, ...image });
      continue;
    }
    const groups = continuation ?? (allowPanelContinuation ? layout.panels : []);
    const sizeError = new RangeError(`图鉴「${section}」超过当前聊天的单图大小上限。`);
    const failure = image instanceof ImageSizeLimitError ? image : sizeError;
    if ((!low && pageScale !== 4 && pageScale !== 2) || groups.length < 2) throw failure;
    // Keep each room or section intact at the smallest scale of the active preset.
    const continuationScale = low ? 1 : 2;
    const reason = low ? "低配整图超限，按原分项续页。" : "二倍整图超限，按原分项续页。";
    const renderContinuation = async (start: number, end: number): Promise<void> => {
      const selected = groups.slice(start, end);
      const range = end === start + 1 ? String(end) : `${start + 1}–${end}`;
      const part = `${range}/${groups.length}`;
      const partSection = `${section}（${part}）`;
      const panels = continuation ? [selected.flat()] : selected;
      const next = await renderWithinCodec({ ...layout, panels }, section, `${pageNumber} · 原分项 ${part}`, continuationScale);
      if (!(next instanceof ImageSizeLimitError) && fits(next)) {
        output.push({ section: partSection, ...next, reducedScaleReason: reason + failure.message });
        return;
      }
      if (end - start < 2) throw next instanceof ImageSizeLimitError ? next : sizeError;
      const middle = start + Math.ceil((end - start) / 2);
      await renderContinuation(start, middle);
      await renderContinuation(middle, end);
    };
    const middle = Math.ceil(groups.length / 2);
    await renderContinuation(0, middle);
    await renderContinuation(middle, groups.length);
  }
  return output;
}
