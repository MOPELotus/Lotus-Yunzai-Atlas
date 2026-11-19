import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { renderPng } from "@lotus-yunzai/skia";
import { Canvas, loadImage, type CanvasRenderingContext2D as Context, type Image } from "skia-canvas";
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
const maxDimension = 16_384;
const maxImageBytes = 8 * 1024 * 1024;
const font = '"MiaoWiki", MiSans, "Noto Sans CJK SC", sans-serif';
const gold = "#e0c89a";
const white = "#f3efea";
const muted = "#c4cad7";
const accents: readonly [RegExp, string][] = [
  [/冰|霜/u, "#34596a"], [/水|以太|量子/u, "#334677"], [/火/u, "#713d45"], [/草|风/u, "#38624f"],
  [/岩|虚数/u, "#675844"], [/雷|电/u, "#554274"],
];

type Block = { readonly height: number; paint(ctx: Context, top: number): void };
type Page = { section: string; panels: Block[][] };

function rounded(ctx: Context, x: number, y: number, w: number, h: number, radius: number, fill: string) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fill();
}

function paintLines(ctx: Context, lines: readonly string[], x: number, y: number, size: number,
  lineHeight: number, color: string, bold = false) {
  ctx.font = `${bold ? "600 " : ""}${size}px ${font}`;
  ctx.textBaseline = "top";
  ctx.fillStyle = color;
  for (const [row, line] of lines.entries()) ctx.fillText(line, x, y + row * lineHeight);
}

function contain(ctx: Context, image: Image, x: number, y: number, w: number, h: number) {
  const scale = Math.min(w / image.width, h / image.height);
  const dw = image.width * scale;
  const dh = image.height * scale;
  ctx.drawImage(image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function makeLayout() {
  const metrics = new Canvas(1, 1);
  metrics.gpu = false;
  const measure = metrics.getContext("2d");

  function wrap(text: string, maxWidth: number, size: number, bold = false) {
    measure.font = `${bold ? "600 " : ""}${size}px ${font}`;
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
    return { height: lines.length * lineHeight + 16, paint: (ctx, top) =>
      paintLines(ctx, lines, margin + 20, top + 8, size, lineHeight, color) };
  }

  function heading(value: string, artwork?: Image, small = false): Block {
    const size = small ? 21 : 26;
    const lineHeight = size + 8;
    const lines = wrap(value, contentWidth - (artwork ? 70 : 0), size, true);
    return { height: Math.max(small ? 48 : 70, lines.length * lineHeight + 24), paint(ctx, top) {
      ctx.fillStyle = "rgba(210,188,153,.10)";
      ctx.fillRect(margin, top, inner, this.height);
      if (artwork) {
        rounded(ctx, margin + 16, top + 8, 52, 52, 26, "rgba(255,255,255,.11)");
        contain(ctx, artwork, margin + 22, top + 14, 40, 40);
      }
      paintLines(ctx, lines, margin + (artwork ? 82 : 20), top + 12, size, lineHeight, gold, true);
    } };
  }

  function row(values: readonly string[], widths: readonly number[], title = false): Block {
    const size = 17;
    const lineHeight = 22;
    const cells = values.map((value, index) => wrap(value, widths[index]! - 12, size, title));
    const height = Math.max(32, ...cells.map((cell) => cell.length * lineHeight + 10));
    return { height, paint(ctx, top) {
      if (title) {
        ctx.fillStyle = "rgba(211,188,142,.15)";
        ctx.fillRect(margin, top, inner, height);
      }
      let x = margin + 20;
      for (const [index, lines] of cells.entries()) {
        paintLines(ctx, lines, x + 6, top + 5, size, lineHeight, title ? gold : white, title);
        x += widths[index]!;
      }
      ctx.fillStyle = "rgba(255,255,255,.08)";
      ctx.fillRect(margin + 20, top + height - 1, contentWidth, 1);
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

  return { wrap, text, heading, row, levelBlocks };
}

async function roleArtwork(role: RoleDetails, assetRoot: string | undefined) {
  const images = new Map<string, Image>();
  if (!assetRoot) return images;
  const root = await realpath(assetRoot).catch(() => undefined);
  if (!root) return images;
  const roots = basename(root) === "data" ? [root, dirname(root)] : [root];
  const paths = new Set([
    role.overview.artwork, ...role.skills.flatMap(({ cards }) => cards.map(({ artwork }) => artwork)),
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

export async function renderRoleBook(role: RoleDetails, options: RoleRenderOptions = {}) {
  const { mode = "auto", scale = 2 } = options;
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new RangeError("图鉴缩放比例须在 1 至 4 之间。");
  const images = await roleArtwork(role, options.assetRoot);
  const image = (path?: string) => path === undefined ? undefined : images.get(path);
  const layout = makeLayout();
  const { wrap, heading, text, row, levelBlocks } = layout;
  const details = ({ label, text: value }: RoleText) => text(label ? `${label}　${value}` : value);
  const portrait = image(role.overview.artwork);
  const overview: Block[][] = [];
  if (portrait) overview.push([{ height: 300, paint: (ctx, top) => contain(ctx, portrait, margin + 20, top + 8, contentWidth, 284) }]);
  const description = role.overview.description;
  const facts = role.overview.facts.map(({ label, value }) => `${label}　${value}`);
  const overviewText = [...(description ? [text(description)] : []), ...(role.overview.rarity ? [text(role.overview.rarity, gold)] : [])];
  for (let start = 0; start < facts.length; start += 3) {
    const values = facts.slice(start, start + 3);
    overviewText.push(row(values, values.map(() => contentWidth / 3)));
  }
  if (overviewText.length) overview.push(overviewText);

  const pages: Page[] = [{ section: "角色总览", panels: overview }];
  const skillPanels = role.skills.filter(({ cards }) => cards.length).flatMap(({ title, cards }) => [
    [heading(title, undefined, true)],
    ...cards.map((card) => [heading(card.name, image(card.artwork)), ...(card.description ? [text(card.description)] : []),
      ...card.details.map(details), ...levelBlocks(card.levels ?? [])]),
  ]);
  if (skillPanels.length) pages.push({ section: { gi: "技能与天赋", hsr: "技能与行迹", zzz: "技能与核心能力" }[role.game], panels: skillPanels });
  if (role.ranks.length) pages.push({ section: { gi: "命座", hsr: "星魂", zzz: "影画" }[role.game], panels: role.ranks.map((rank) => [
    heading(`${rank.rank} · ${rank.name}`, image(rank.artwork)),
    ...(rank.description ? [text(rank.description)] : []), ...(rank.story ? [text(rank.story, muted, 17)] : []),
  ]) });
  const materials = role.materials.filter(({ items }) => items.length);
  if (materials.length) pages.push({ section: "养成材料", panels: materials.map(({ title, items, cost }) => [
    heading(title, undefined, true), ...(cost === undefined ? [] : [text(`消耗　${cost}`, gold)]),
    ...items.map((item) => heading(`${item.name || item.id || "材料"}　× ${item.count}`, image(item.artwork))),
  ]) });

  const game = gameNames[role.game];
  const title = wrap(role.overview.name, 620, 32, true);
  const element = role.overview.facts.find(({ label }) => label === "属性")?.value ?? "";
  const accent = accents.find(([pattern]) => pattern.test(element))?.[1] ?? "#41495d";
  const head = Math.max(header, 118 + title.length * 37);
  const output = [];
  for (const [index, { section, panels }] of pages.entries()) {
    const heights = panels.map((blocks) => blocks.reduce((sum, { height }) => sum + height, 0));
    const height = Math.max(460, head + heights.reduce((sum, panelHeight) => sum + panelHeight + 16, 0) + footer);
    if (height > maxDimension) throw new RangeError(`图鉴「${section}」超出可渲染高度。`);
    const zoom = Math.min(scale, maxDimension / height);
    const { png, engine } = await renderPng(Math.floor(width * zoom), Math.floor(height * zoom), (ctx) => {
      ctx.scale(zoom, zoom);
      const bg = ctx.createLinearGradient(0, 0, width, height);
      bg.addColorStop(0, accent);
      bg.addColorStop(.45, "#252c40");
      bg.addColorStop(1, "#151a29");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      rounded(ctx, margin, 12, inner, head - 32, 12, "rgba(13,17,29,.60)");
      rounded(ctx, 33, 28, 102, 102, 51, "rgba(225,201,160,.12)");
      if (portrait) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(84, 79, 50, 0, Math.PI * 2);
        ctx.clip();
        contain(ctx, portrait, 33, 28, 102, 102);
        ctx.restore();
      }
      ctx.strokeStyle = gold;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(84, 79, 51, 0, Math.PI * 2);
      ctx.stroke();
      paintLines(ctx, title, 152, 30, 32, 37, white, true);
      const page = `${index + 1}/${pages.length}`;
      paintLines(ctx, [`${game} · ${section} · ${page}`], 154, 42 + title.length * 37, 18, 27, gold);
      if (role.version) paintLines(ctx, [`资料版本 ${role.version}`], 154, 72 + title.length * 37, 14, 21, muted);

      let y = head;
      for (const [panel, blocks] of panels.entries()) {
        const panelHeight = heights[panel]!;
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(margin, y, inner, panelHeight, 10);
        ctx.clip();
        ctx.fillStyle = "rgba(12,17,29,.62)";
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
