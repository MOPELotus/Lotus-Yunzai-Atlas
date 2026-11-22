import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtlasCatalog } from "./catalog.ts";
import { atlasStatus } from "./status.ts";

test("图鉴状态文字回退含有效来源、图库、语言、总数和分类版本", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-status-"));
  try {
    const directory = join(root, "data");
    await mkdir(directory);
    await mkdir(join(root, "gallery"));
    const weapon = { version: "7.2", recordCount: 1, records: { "1": { id: "1", name: "西风剑", path: "items/1.json" } } };
    await Bun.write(join(directory, "map.json"), JSON.stringify({ games: { gi: { locales: { zh: { pages: { weapon } } } } } }));
    expect(await atlasStatus(createAtlasCatalog(directory), { inlineImageByteLimit: 1 })).toBe([
      "图鉴状态", "READY", `数据目录：${await realpath(directory)}`, "条目：1 个", "分类：1 个", "图库：已找到", "语言：简体中文",
      "原神 · 武器 · 7.2 · 1 个条目",
    ].join("\n"));

    const missing = join(root, "absent");
    expect(await atlasStatus(createAtlasCatalog(missing), { inlineImageByteLimit: 1 })).toContain([
      "图鉴状态", "MISSING", `数据目录：${missing}`, "条目：缺失", "分类：缺失", "图库：缺失", "语言：简体中文", "图鉴数据不可用。",
    ].join("\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
