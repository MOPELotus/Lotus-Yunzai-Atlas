import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectExporterPages } from "./download-legacy-atlas.ts";
import { seedExporterFromPublished } from "./export-workspace-seed.ts";

const row = { zh: "旧资料" };
const path = "items/202.json";
const localPath = "gallery/gi/legacy.webp";
const sha256 = createHash("sha256").update("image").digest("hex");
const scope = [{ game: "gi", pageId: "monster", version: "7.2", recordCount: 1,
  rows: new Map([["202", JSON.stringify(row)]]) }] as const;

async function fixture(run: (snapshot: string, backend: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-seed-"));
  try {
    const snapshot = join(root, "published");
    const data = join(snapshot, "data");
    await mkdir(join(data, "items"), { recursive: true });
    await mkdir(join(snapshot, "gallery", "gi"), { recursive: true });
    const page = { id: "monster", version: "7.2", sampled: false, recordCount: 1, totalRecordCount: 1,
      records: { "202": { id: "202", name: "旧资料", hasDetail: true, path } } };
    await writeFile(join(data, "map.json"), JSON.stringify({ games: { gi: { locales: { zh: { pages: { monster: page } } } } } }));
    await writeFile(join(data, path), JSON.stringify({
      meta: { gameId: "gi", pageId: "monster", recordId: "202", version: "7.2", name: "旧资料", locale: "zh",
        hasDetail: true, images: [{ status: "downloaded", placeholder: false, localPath, sha256 }] },
      content: { list: row, detail: { desc: "资料" } },
    }));
    await writeFile(join(snapshot, localPath), "image");
    await writeFile(join(data, "unreferenced.json"), "unrelated");
    await run(snapshot, join(root, "private-backend"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("从发布快照复制原条目和校验过的素材，重建导出索引后可直接复用", () => fixture(async (snapshot, backend) => {
  await seedExporterFromPublished(join(snapshot, "data"), backend);
  expect([...(await inspectExporterPages(backend, undefined, scope)).completed]).toEqual(["gi/monster"]);
  const gallery = JSON.parse(await readFile(join(backend, "data", "gallery-index.json"), "utf8"));
  expect(gallery.images).toEqual([{ status: "downloaded", placeholder: false, localPath, sha256,
    gameId: "gi", pageId: "monster", recordId: "202" }]);
  expect(await Bun.file(join(snapshot, "data", "gallery-index.json")).exists()).toBe(false);
  expect(await Bun.file(join(backend, "data", "unreferenced.json")).exists()).toBe(false);
  await writeFile(join(backend, localPath), "edited");
  expect(await readFile(join(snapshot, localPath), "utf8")).toBe("image");
}));

test("快照原图校验失败时拒绝用作下载种子", () => fixture(async (snapshot, backend) => {
  await writeFile(join(snapshot, localPath), "broken");
  await expect(seedExporterFromPublished(join(snapshot, "data"), backend)).rejects.toThrow("内容与记录不符");
  expect(await Bun.file(join(backend, "data", "gallery-index.json")).exists()).toBe(false);
  expect(await readFile(join(snapshot, localPath), "utf8")).toBe("broken");
}));

test("新增七圣留在现用快照，旧导出器种子继续只复用可管理的旧分类", () => fixture(async (snapshot, backend) => {
  const data = join(snapshot, "data");
  const mapPath = join(data, "map.json");
  const map = JSON.parse(await readFile(mapPath, "utf8"));
  const card = { id: "1101", name: "甘雨", hasDetail: false, path: "items/gcg-1101.json" };
  map.games.gi.locales.zh.pages.gcg = { id: "gcg", version: "7.2", sampled: false, recordCount: 1,
    totalRecordCount: 1, records: { [card.id]: card } };
  const original = JSON.stringify(map);
  await writeFile(mapPath, original);
  const details = JSON.stringify({
    meta: { gameId: "gi", pageId: "gcg", recordId: card.id, version: "7.2", name: card.name, locale: "zh", hasDetail: false },
    content: { list: { zh: card.name }, detail: null },
  });
  await writeFile(join(data, card.path), details);

  await seedExporterFromPublished(data, backend);
  const inspected = await inspectExporterPages(backend, undefined, scope);
  expect(inspected.exactScope).toBe(true);
  expect([...inspected.completed]).toEqual(["gi/monster"]);
  expect(await Bun.file(join(backend, "data", card.path)).exists()).toBe(false);
  expect(await readFile(mapPath, "utf8")).toBe(original);
  expect(await readFile(join(data, card.path), "utf8")).toBe(details);
}));
