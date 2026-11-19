import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtlasCatalog, type AtlasEntry } from "./catalog.ts";
import { normalizeSet } from "./set-data.ts";

const entry: AtlasEntry = { game: "gi", name: "套装样例", id: "14001", version: "sample", rarity: "", path: "items/set.json" };

test("圣遗物从同版本详情保留套装效果与登记的部件图", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-set-"));
  try {
    await mkdir(join(root, "items"));
    const file = join(root, entry.path);
    const meta = { gameId: "gi", pageId: "artifact", recordId: entry.id, version: entry.version, images: [
      { fieldPath: "detail.icon", localPath: "gallery/gi/overview.webp", status: "downloaded", placeholder: false },
      { fieldPath: "detail.parts.equip_ring.icon", localPath: "gallery/gi/ring.webp", status: "downloaded", placeholder: false },
      { fieldPath: "detail.parts.equip_dress.icon", localPath: "gallery/gi/../escape.webp", status: "downloaded", placeholder: false },
    ] };
    const content = { detail: { need: [2, 4], affix: [{ name: "来源标题", desc: "效果甲" }, { desc: "效果乙" }],
      parts: { equip_ring: { name: "部件甲" }, equip_dress: { name: "部件乙" }, unknown: { icon: "未识别" } } } };
    await writeFile(file, JSON.stringify({ meta, content }));
    const catalog = createAtlasCatalog(root);
    const details = await catalog.setDetails(entry);
    expect(details?.artwork).toBe("gallery/gi/overview.webp");
    expect(details?.effects).toEqual([
      { pieces: 2, title: "来源标题", text: "效果甲" }, { pieces: 4, title: "4件套", text: "效果乙" },
    ]);
    expect(details?.parts).toEqual([{ id: "equip_ring", name: "部件甲", artwork: "gallery/gi/ring.webp" },
      { id: "equip_dress", name: "部件乙", artwork: undefined }]);
    expect(await catalog.setDetails({ ...entry, version: "later" })).toBeUndefined();
    await writeFile(file, JSON.stringify({ meta: { ...meta, pageId: "weapon" }, content }));
    expect(await catalog.setDetails(entry)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("星铁缺图时保留部件原名，绝区零只展示有来源的效果和故事", () => {
  const relic = normalizeSet({ ...entry, game: "hsr" }, { detail: { name: "套装原名", require_num: {
    2: { desc: "提升<unbreak>#1[i]%</unbreak>。", param_list: [0.12] },
  }, parts: { 33015: { name: "部件甲" }, 33016: { name: "部件乙" } } } }, []);
  expect(relic?.effects).toEqual([{ pieces: 2, title: "套装原名", text: "提升12%。" }]);
  expect(relic?.parts).toEqual([{ id: "33015", name: "部件甲", artwork: undefined },
    { id: "33016", name: "部件乙", artwork: undefined }]);

  const disk = normalizeSet({ ...entry, game: "zzz" }, { detail: { name: "驱动盘原名", desc2: "两件效果。",
    story: "<color=#ffffff>故事。</color>", parts: { 1: { name: "未采用的部件" } } } }, []);
  expect(disk?.effects).toEqual([{ pieces: 2, title: "驱动盘原名", text: "两件效果。" }]);
  expect(disk?.parts).toEqual([]);
  expect(disk?.story).toBe("故事。");
  expect(normalizeSet(entry, { list: { name: "只有索引" } }, [])).toBeUndefined();
});
