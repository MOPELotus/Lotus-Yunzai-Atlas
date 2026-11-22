import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectFullAtlasCandidate } from "./refresh-source.ts";
import type { AtlasCandidatePage } from "./validate-candidate.ts";

const roots: string[] = [];
const weapon = { game: "gi", pageId: "weapon", version: "7.2" } as const;
const tower = { game: "gi", pageId: "tower", version: "7.2" } as const;
const elite = { game: "hsr", pageId: "EliteGroup", version: "4.7" } as const;
const bytes = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
const imagePath = "gallery/gi/weapon/original.webp";
const image = {
  fieldPath: "detail.icon", status: "downloaded", placeholder: false, localPath: imagePath,
  sha256: createHash("sha256").update(bytes).digest("hex"), remoteUrl: "https://old.invalid/original.webp",
};
type Row = { id: string; name: string; list?: unknown; detail?: unknown; images?: unknown[] };
type Page = AtlasCandidatePage & { version: string; rows: Row[] };
const old = { id: "1", name: "已收录武器", detail: { desc: "现用详情" }, images: [image] };
const history = { id: "2", name: "历史武器", detail: { desc: "历史详情" } };

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function snapshot(pages: readonly Page[], options: {
  relocated?: boolean; number?: string; artwork?: readonly [string, Buffer]; neglectArtwork?: boolean; omitRarity?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "lotus-full-candidate-"));
  roots.push(root);
  const data = join(root, "data");
  const games: Record<string, { locales: { zh: { pages: Record<string, unknown> } } }> = {};
  for (const { game, pageId, version, rows } of pages) {
    const records: Record<string, unknown> = {};
    for (const { id, name, list = { zh: name, raw: "@plain-number@" }, detail = null, images = [] } of rows) {
      const path = `items/${options.relocated ? "relocated/" : ""}${game}/${pageId}/${id}.json`;
      const hasDetail = detail !== null;
      records[id] = { id, name, path, hasDetail, rarity: options.omitRarity ? undefined : "五星" };
      await Bun.write(join(data, path), JSON.stringify({
        meta: { gameId: game, pageId, version, recordId: id, name, hasDetail, images, locale: "zh",
          generatedAt: options.relocated ? "different time" : "old time" },
        content: { list, detail },
      }).replaceAll('"@plain-number@"', options.number ?? "1"));
    }
    const gameData = games[game] ??= { locales: { zh: { pages: {} } } };
    gameData.locales.zh.pages[pageId] = { id: pageId, version, records, recordCount: rows.length,
      totalRecordCount: rows.length, sampled: false };
  }
  await Bun.write(join(data, "map.json"), JSON.stringify({ meta: { generatedAt: Date.now() }, games }));
  if (!options.neglectArtwork) {
    const [path, body] = options.artwork ?? [imagePath, bytes];
    await Bun.write(join(root, path), body);
  }
  return data;
}

test("全量比较在重建后的完整候选上保护现用记录、已可用详情和原图", async () => {
  const before = await snapshot([{ ...weapon, rows: [old, history] }]);
  const current = await snapshot([{ ...weapon, rows: [{ ...old, detail: { empty: [] }, images: [] }] }]);
  const result = await inspectFullAtlasCandidate(before, current, [weapon]);
  expect(result.unchanged).toBe(false);
  expect(result.issues).toEqual([
    expect.stringContaining("1 缺少已有详情"),
    expect.stringContaining("1 缺少已下载图标 detail.icon"),
    expect.stringContaining("2 缺少已有条目"),
  ]);
  const broken = await snapshot([{ ...weapon, rows: [old, history] }], { neglectArtwork: true });
  expect((await inspectFullAtlasCandidate(before, broken, [weapon])).issues)
    .toContainEqual(expect.stringContaining("缺少可验证原图"));
  const repaired = await inspectFullAtlasCandidate(broken, before, [weapon]);
  expect(repaired).toEqual({ unchanged: false, issues: [] });
});

test("相同有效数据和原图保持当前；确认的新图和精确数值变化能发布", async () => {
  const before = await snapshot([{ ...weapon, rows: [old, history] }], { number: "17949999999999999999" });
  const localPath = "gallery/gi/weapon/verified.webp";
  const renamed = { ...old, images: [{ ...image, localPath, remoteUrl: "https://other.invalid/verified.webp" }] };
  const same = await snapshot([{ ...weapon, rows: [history, renamed] }],
    { relocated: true, number: "17949999999999999999.0", artwork: [localPath, bytes] });
  expect(await inspectFullAtlasCandidate(before, same, [weapon])).toEqual({ unchanged: true, issues: [] });
  const precise = await snapshot([{ ...weapon, rows: [history, renamed] }],
    { relocated: true, number: "17950000000000000000", artwork: [localPath, bytes] });
  expect(await inspectFullAtlasCandidate(before, precise, [weapon])).toEqual({ unchanged: false, issues: [] });
  const body = Buffer.from("UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAgA0JaACdLoB+AADsAD+8MQL/yC5YXXI1/8gP+QH/ID/+PIAAAA=", "base64");
  const newArt = { ...renamed, images: [{ ...renamed.images[0], sha256: createHash("sha256").update(body).digest("hex") }] };
  const newImage = await snapshot([{ ...weapon, version: "7.3", rows: [history, newArt] }],
    { number: "17949999999999999999", artwork: [localPath, body] });
  expect(await inspectFullAtlasCandidate(before, newImage, [{ ...weapon, version: "7.3" }])).toEqual({ unchanged: false, issues: [] });
  expect((await inspectFullAtlasCandidate(newImage, before, [weapon])).issues)
    .toContainEqual(expect.stringContaining("不能证明晚于现用"));
});

test("旧深境场次保留身份、实装窗口和可用楼层", async () => {
  const row = { id: "123", name: "第一百二十三期", list: { live_begin: "2026-09-16 04:00:00", live_end: "2026-10-16 03:59:59" },
    detail: { floor: { "11": {}, "12": {} }, title: "历史祝福" } };
  const before = await snapshot([{ ...tower, rows: [row] }]);
  const next = await snapshot([{ ...tower, version: "7.3", rows: [{ ...row, name: "另一场次",
    list: { ...row.list, live_end: "2026-10-17 03:59:59" }, detail: { floor: { "11": {} }, title: "历史祝福" } }] }]);
  expect((await inspectFullAtlasCandidate(before, next, [{ ...tower, version: "7.3" }])).issues).toEqual([
    expect.stringContaining("已有身份或实装窗口冲突"),
    expect.stringContaining("缺少已有挑战分区"),
  ]);
});

test("星铁组页重新排序使用原复合键，合成候选可增加新页和新记录", async () => {
  const list = (EliteGroup: number) => ({ EliteGroup, AttackRatio: 1, HPRatio: 1,
    StanceRatio: 1, SpeedRatio: 1, DefenceRatio: 1 });
  const first = { id: "0", name: "0", list: list(71) };
  const second = { id: "1", name: "1", list: list(90) };
  const before = await snapshot([{ ...elite, rows: [first, second] }]);
  const reordered = [{ ...first, name: "1", id: "1" }, { ...second, name: "0", id: "0" }];
  const same = await snapshot([{ ...elite, rows: reordered }]);
  expect(await inspectFullAtlasCandidate(before, same, [elite])).toEqual({ unchanged: true, issues: [] });
  const added = await snapshot([{ ...elite, rows: reordered }, { ...weapon, rows: [old, history] }]);
  expect(await inspectFullAtlasCandidate(before, added, [elite, weapon])).toEqual({ unchanged: false, issues: [] });
  const missing = await snapshot([{ ...weapon, rows: [old] }]);
  expect((await inspectFullAtlasCandidate(added, missing, [weapon])).issues)
    .toContainEqual("缺少现用分类 hsr/EliteGroup。");
});
