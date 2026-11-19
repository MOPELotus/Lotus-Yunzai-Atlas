import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAtlasCandidate } from "./validate-candidate.ts";

const game = "gi";
const identity = { gameId: game, locale: "zh", pageId: "character", recordId: "42", name: "角色样例", version: "1", hasDetail: true };
const row = { id: "42", name: identity.name, path: "items/42.json", hasDetail: true };
const page = { id: "character", version: "1", recordCount: 1, totalRecordCount: 1, sampled: false, records: { "42": row } };

async function withCandidate(run: (root: string, setPage: (value: unknown) => Promise<void>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-candidate-"));
  try {
    const items = join(root, "items");
    await mkdir(items);
    await writeFile(join(root, row.path), JSON.stringify({ meta: identity, content: { list: {}, detail: {} } }));
    const setPage = (value: unknown) => writeFile(join(root, "map.json"), JSON.stringify({
      games: { gi: { locales: { zh: { pages: { character: value } } } } },
    }));
    await setPage(page);
    await run(root, setPage);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("完整候选报告分类、真实记录数及版本，拒绝缺失的预期分类", () => withCandidate(async (root) => {
  const expected = { game, pageId: "character", version: "1", recordCount: 1 } as const;
  expect(await validateAtlasCandidate(root, [expected])).toEqual({ ok: true, pages: [expected], issueCount: 0, issues: [] });
  for (const requirement of [{ ...expected, pageId: "weapon" }, { ...expected, version: "2" }, { ...expected, recordCount: 2 }]) {
    const result = await validateAtlasCandidate(root, [requirement]);
    expect(result.ok).toBe(false);
    expect(result.issueCount).toBe(1);
    expect(result.pages).toEqual([expected]);
  }
}));

test("候选不收样本、计数错误、重复路径或路径越界", () => withCandidate(async (root, setPage) => {
  for (const invalid of [
    { ...page, sampled: true }, { ...page, recordCount: 2 }, { ...page, totalRecordCount: 2 },
    { ...page, records: { "41": row } },
    { ...page, records: { "42": { ...row, path: "items/../map.json" } } },
    { ...page, recordCount: 2, totalRecordCount: 2, records: { "42": row, "43": { ...row, id: "43" } } },
  ]) {
    await setPage(invalid);
    const result = await validateAtlasCandidate(root);
    expect(result.ok).toBe(false);
    expect(result.pages).toEqual([]);
  }
}));

test("每个条目都须是对应游戏、分类、版本及名称的实体 JSON", () => withCandidate(async (root) => {
  const file = join(root, row.path);
  for (const meta of [{ ...identity, version: "2" }, { ...identity, pageId: "weapon" }, { ...identity, locale: "en" },
    { ...identity, name: "冲突名字" }, { ...identity, hasDetail: false }]) {
    await writeFile(file, JSON.stringify({ meta, content: { list: {}, detail: null } }));
    expect((await validateAtlasCandidate(root)).ok).toBe(false);
  }
  await writeFile(file, JSON.stringify({ meta: identity, content: { list: {}, detail: [1] } }));
  expect((await validateAtlasCandidate(root)).ok).toBe(true);
  await rm(file);
  expect((await validateAtlasCandidate(root)).ok).toBe(false);
  await writeFile(join(root, "another.json"), JSON.stringify({ meta: identity, content: { list: {}, detail: {} } }));
  await symlink("../another.json", file);
  expect((await validateAtlasCandidate(root)).ok).toBe(false);
}));

test("取消候选校验不进行文件读取", async () => {
  const reason = new Error("候选已取消");
  await expect(validateAtlasCandidate("missing", [], AbortSignal.abort(reason))).rejects.toBe(reason);
});
