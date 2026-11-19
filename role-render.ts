import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPng } from "@lotus-yunzai/skia";
import { Canvas, FontLibrary, loadImage, type CanvasRenderingContext2D as Context, type Image } from "skia-canvas";
import { gameNames } from "./catalog.ts";
import type { RoleDetails, RoleSkillCard, RoleText } from "./role-data.ts";

export interface RoleRenderOptions {
  readonly mode?: "auto" | "gpu" | "cpu";
  readonly scale?: number;
  readonly assetRoot?: string;
}

const width = 800;
const margin = 24;
const inner = width - 2 * margin;
const contentWidth = inner - 40;
const header = 184;
const footer = 62;
const maxDimension = 24_000;
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
type ThemeAsset = `bg/bg-${Background}.webp` | "card-bg.png";
const themeDirectory = Bun.env.LOTUS_ATLAS_THEME_DIR?.trim() || fileURLToPath(new URL("./assets/miao-theme/", import.meta.url));
const themeImages = new Map<ThemeAsset, Promise<Image | undefined>>();
let themeFonts: Promise<void> | undefined;

async function loadThemeFonts(): Promise<void> {
  for (const [family, filename] of [["MiaoWiki", "HYWH-65W.ttf"], ["MiSans", "MiSans-VF.ttf"]] as const) {
    const paths = [join(themeDirectory, "fonts", filename)];
    if (family === "MiSans") paths.push(join(dirname(themeDirectory), "fonts", filename));
    for (const path of paths) {
      if (!await Bun.file(path).exists()) continue;
      FontLibrary.use(family, [path]);
      break;
    }
  }
}

function themeImage(asset: ThemeAsset): Promise<Image | undefined> {
  let image = themeImages.get(asset);
  if (!image) {
    image = Bun.file(join(themeDirectory, asset)).arrayBuffer()
      .then((bytes) => loadImage(Buffer.from(bytes))).catch(() => undefined);
    themeImages.set(asset, image);
  }
  return image;
}

type Block = { readonly height: number; paint(ctx: Context, top: number): void };
type Page = { section: string; panels: Block[][] };

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

function makeLayout(texture?: Image) {
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

  function text(value: string, color = white, size = 19): Block {
    const lines = wrap(value, contentWidth, size);
    const lineHeight = size + 10;
    return { height: lines.length * lineHeight + 20, paint: (ctx, top) =>
      paintLines(ctx, lines, margin + 20, top + 10, size, lineHeight, color) };
  }

  function heading(value: string, artwork?: Image, small = false): Block {
    const size = small ? 21 : 26;
    const lineHeight = size + 8;
    const lines = wrap(value, inner - (artwork ? 124 : 40), size);
    return { height: Math.max(small ? 48 : 82, lines.length * lineHeight + (small ? 24 : 35)), paint(ctx, top) {
      if (texture) ctx.drawImage(texture, margin, top, inner, this.height);
      if (artwork) {
        rounded(ctx, 40, top + 11, 62, 62, 31, "rgba(255,255,255,0.10)");
        contain(ctx, artwork, 49, top + 20, 44, 44);
      }
      paintLines(ctx, lines, artwork ? 122 : 44, top + (small ? 12 : 14), size, lineHeight, gold);
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

  function material(name: string, count: number, artwork?: Image): Block {
    const lines = wrap(name, inner - 180, 20);
    const quantity = wrap(`× ${count}`, 102, 21);
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

  return { wrap, text, heading, statRow, material, levelBlocks };
}

async function roleArtwork(role: RoleDetails, assetRoot: string | undefined) {
  const images = new Map<string, Image>();
  if (!assetRoot) return images;
  const root = await realpath(assetRoot).catch(() => undefined);
  if (!root) return images;
  const roots = basename(root) === "data" ? [root, dirname(root)] : [root];
  const paths = new Set([
    role.overview.icon, role.overview.artwork, ...role.skills.flatMap(({ cards }) => cards.map(({ artwork }) => artwork)),
    ...role.ranks.map(({ artwork }) => artwork), ...role.materials.flatMap(({ items }) => items.map(({ artwork }) => artwork)),
  ]);
  for (const path of paths) {
    if (!path?.startsWith(`gallery/${role.game}/`) || !/\.(?:png|webp|jpe?g)$/iu.test(path) ||
        !path.split("/").every((part) => /^[\p{L}\p{N}][\p{L}\p{N}_. -]*$/u.test(part))) continue;
    for (const base of roots) {
      try {
        const resolved = await realpath(join(base, path));
        if (!resolved.startsWith(join(base, "gallery", role.game) + sep)) continue;
        const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > maxImageBytes) continue;
          const bytes = Buffer.alloc(stat.size);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
          if (bytesRead < bytes.length) continue;
          images.set(path, await loadImage(bytes));
          break;
        } finally {
          await file.close();
        }
      } catch {
        // A missing or unreadable illustration still leaves the complete text available.
      }
    }
  }
  return images;
}

function measurePage(head: number, panels: readonly Block[][]) {
  const heights = panels.map((blocks) => blocks.reduce((sum, { height }) => sum + height, 0));
  return { heights, height: Math.max(460, head + heights.reduce((sum, panelHeight) => sum + panelHeight + 16, 0) + footer) };
}

export async function renderRoleBook(role: RoleDetails, options: RoleRenderOptions = {}) {
  const { mode = "auto", scale = 2 } = options;
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new RangeError("图鉴缩放比例须在 1 至 4 之间。");
  const property = role.overview.facts.find(({ label }) => label === "属性") ??
    role.overview.facts.find(({ label }) => label === "神之眼" || label === "元素");
  const backdrop = backgrounds.find(([pattern]) => pattern.test(property?.value ?? ""))?.[1] ?? "sr";
  const [images, background, texture] = await Promise.all([
    roleArtwork(role, options.assetRoot), themeImage(`bg/bg-${backdrop}.webp`), themeImage("card-bg.png"),
    themeFonts ??= loadThemeFonts(),
  ]);
  const image = (path?: string) => path === undefined ? undefined : images.get(path);
  const layout = makeLayout(texture);
  const { wrap, heading, text, statRow, material } = layout;
  const details = ({ label, text: value }: RoleText) => text(label ? `${label}　${value}` : value);
  const icon = image(role.overview.icon);
  const portrait = image(role.overview.artwork);
  const titleX = icon ? 152 : margin + 20;
  const title = wrap(role.overview.name, icon ? 620 : contentWidth, 33);
  const head = Math.max(header, 118 + title.length * 39);
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

  const pages: Page[] = [{ section: "角色总览", panels: overview.length ? [overview] : [] }];
  const skills = role.skills.filter(({ cards }) => cards.length).flatMap(({ title, cards }) => [
    [heading(title, undefined, true)],
    ...cards.map((card) => [heading(card.name, image(card.artwork)), ...(card.description ? [text(card.description)] : []),
      ...card.details.map(details), ...layout.levelBlocks(card.levels ?? [])]),
  ]);
  if (skills.length) pages.push({ section: { gi: "技能与天赋", hsr: "技能与行迹", zzz: "技能与核心能力" }[role.game], panels: skills });
  if (role.ranks.length) pages.push({ section: { gi: "命座", hsr: "星魂", zzz: "影画" }[role.game], panels: role.ranks.map((rank) => [
    heading(`${rank.rank} · ${rank.name}`, image(rank.artwork)),
    ...(rank.description ? [text(rank.description)] : []), ...(rank.story ? [text(rank.story, muted, 17)] : []),
  ]) });
  const materials = role.materials.filter(({ items }) => items.length);
  if (materials.length) pages.push({ section: "养成材料", panels: materials.map(({ title, items, cost }) => [
    heading(title, undefined, true), ...(cost === undefined ? [] : [text(`消耗　${cost}`, gold)]),
    ...items.map((item) => material(item.name || item.id || "材料", item.count, image(item.artwork))),
  ]) });

  const game = gameNames[role.game];
  const output = [];
  for (const [index, { section, panels }] of pages.entries()) {
    const { heights, height } = measurePage(head, panels);
    if (height > maxDimension) throw new RangeError(`图鉴「${section}」超出可渲染高度。`);
    const zoom = Math.min(scale, maxDimension / height);
    const { png, engine } = await renderPng(Math.floor(width * zoom), Math.floor(height * zoom), (ctx) => {
      ctx.scale(zoom, zoom);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.fillStyle = "#252c40";
      ctx.fillRect(0, 0, width, height);
      if (background) ctx.drawImage(background, 0, 0, width, height);

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
      const page = `${index + 1}/${pages.length}`;
      paintLines(ctx, [`${game} · ${section} · ${page}`], titleX + 2, 35 + title.length * 39, 18, 29, gold);
      paintLines(ctx, [role.version ? `资料版本 ${role.version}` : "角色与装备资料"], titleX + 2, 69 + title.length * 39, 14, 29, muted);

      let y = head;
      for (const [panel, blocks] of panels.entries()) {
        const panelHeight = heights[panel]!;
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(margin, y, inner, panelHeight, 10);
        ctx.clip();
        ctx.fillStyle = "rgba(15,20,31,0.58)";
        ctx.fillRect(margin, y, inner, panelHeight);
        for (const block of blocks) {
          block.paint(ctx, y);
          y += block.height;
        }
        ctx.restore();
        y += 16;
      }
      paintLines(ctx, [`Lotus-Yunzai · Nanoka Atlas · ${page}`], margin, height - 37, 14, 21, muted);
    }, mode);
    output.push({ section, png, engine });
  }
  return output;
}
