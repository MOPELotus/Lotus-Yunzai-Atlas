import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectExporterPages, readSelectedExporterIndexes } from "./download-legacy-atlas.ts";
import { legacyAtlasSourcePages } from "./legacy-source-profile.ts";
import { atlasSourceOrigin } from "./source-transport.ts";

const selected = { gi: "7.2", hsr: "4.7", zzz: "3.3" };
const row = { zh: "旧条目", icon: "icon" };

test("版本导出读取三个所选版本的完整范围和真实原索引条目数", async () => {
  const requests: string[] = [];
  const scope = await readSelectedExporterIndexes(selected, undefined, async (url, options) => {
    const { origin, pathname } = new URL(url);
    expect(origin).toBe(atlasSourceOrigin);
    expect(options.credentials).toBe("omit");
    expect(options.redirect).toBe("error");
    requests.push(pathname);
    const array = /\/(?:EliteGroup|HardLevelGroup|InfiniteEliteGroup)\.json$/u.test(pathname);
    return Response.json(array ? [row, { zh: "第二条" }] : { "202": row });
  });
  expect(requests).toHaveLength(29);
  expect(requests).toContain("/gi/7.2/zh/achievement/achievement.json");
  expect(requests).toContain("/hsr/4.7/EliteGroup.json");
  expect(requests).toContain("/zzz/3.3/character.json");
  expect(scope.map(({ game, pageId }) => `${game}/${pageId}`)).toEqual(
    legacyAtlasSourcePages.map(({ game, pageId }) => `${game}/${pageId}`));
  expect(scope.find(({ game, pageId }) => game === "gi" && pageId === "monster")?.recordCount).toBe(1);
  expect([...scope.find(({ pageId }) => pageId === "EliteGroup")!.rows.keys()]).toEqual(["0", "1"]);
});

test("所选版本或任一原索引无效时整组准备失败", async () => {
  let requests = 0;
  const source = async () => { requests++; return Response.json({ "202": row }); };
  await expect(readSelectedExporterIndexes({ ...selected, zzz: "../3.3" }, undefined, source)).rejects.toThrow("zzz");
  expect(requests).toBe(0);
  await expect(readSelectedExporterIndexes(selected, undefined, async (url) => url.endsWith("/zzz/3.3/monster.json")
    ? new Response(null, { status: 404 })
    : Response.json(/\/(?:EliteGroup|HardLevelGroup|InfiniteEliteGroup)\.json$/u.test(url) ? [row] : { "202": row })))
    .rejects.toThrow("HTTP 404");
});

test("可只准备点名的原站分类，并拒绝无效或重复范围", async () => {
  const requests: string[] = [];
  const request = async (url: string) => {
    const { pathname } = new URL(url);
    requests.push(pathname);
    return Response.json(pathname.endsWith("/EliteGroup.json") ? [row] : { "202": row });
  };
  const scope = [{ game: "gi", pageId: "monster" }, { game: "hsr", pageId: "EliteGroup" }] as const;
  const partial = { gi: "7.2", hsr: "4.7" };
  const pages = await readSelectedExporterIndexes(partial, undefined, request, scope);
  expect(requests).toEqual(["/gi/7.2/monster.json", "/hsr/4.7/EliteGroup.json"]);
  expect(pages.map(({ game, pageId }) => ({ game, pageId }))).toEqual([...scope]);
  for (const selection of [[], [scope[0], scope[0]], [{ game: "gi", pageId: "other" }] as const]) {
    await expect(readSelectedExporterIndexes(selected, undefined, request, selection)).rejects.toThrow("图鉴分类");
  }
  await expect(readSelectedExporterIndexes({ gi: "7.2" }, undefined, request, scope)).rejects.toThrow("hsr");
  await expect(readSelectedExporterIndexes(partial, undefined, request)).rejects.toThrow("zzz");
  expect(requests).toHaveLength(2);
});

test("同版相同数量但内容或条目身份改变时不能复用，完全一致时保留现有条目", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-version-index-"));
  try {
    const path = "items/entry.json";
    const data = join(root, "data");
    const game = "gi";
    const pageId = "monster";
    const version = "7.2";
    const page = { id: pageId, version, sampled: false, recordCount: 1, totalRecordCount: 1,
      records: { "202": { id: "202", name: "旧条目", hasDetail: true, path } } };
    await mkdir(join(data, "items"), { recursive: true });
    await writeFile(join(data, "map.json"), JSON.stringify({ games: { gi: { locales: { zh: { pages: { monster: page } } } } } }));
    await writeFile(join(data, "gallery-index.json"), JSON.stringify({ images: [] }));
    await writeFile(join(data, path), JSON.stringify({
      meta: { gameId: game, pageId, version, recordId: "202", name: "旧条目", locale: "zh", hasDetail: true },
      content: { list: row, detail: { desc: "旧详情" } },
    }));
    const scope = (id: string, value: unknown) => [{ game, pageId, version, recordCount: 1,
      rows: new Map([[id, JSON.stringify(value)]]) }] as const;
    expect([...(await inspectExporterPages(root, undefined, scope("202", row))).completed]).toEqual(["gi/monster"]);
    expect((await inspectExporterPages(root, undefined, scope("203", row))).completed.size).toBe(0);
    expect((await inspectExporterPages(root, undefined, scope("202", { ...row, icon: "updated" }))).completed.size).toBe(0);
    expect((await inspectExporterPages(root)).completed.size).toBe(0);

    const other = "items/other.json";
    const otherPage = { ...page, id: "weapon", records: { "202": { ...page.records["202"], path: other } } };
    await writeFile(join(data, "map.json"), JSON.stringify({
      games: { gi: { locales: { zh: { pages: { monster: page, weapon: otherPage } } } } },
    }));
    await writeFile(join(data, other), JSON.stringify({
      meta: { gameId: game, pageId: "weapon", version, recordId: "202", name: "旧条目", locale: "zh", hasDetail: true },
      content: { list: row, detail: { desc: "另一分类详情" } },
    }));
    const checked = await inspectExporterPages(root, undefined, scope("202", row));
    expect([...checked.completed]).toEqual(["gi/monster"]);
    expect(checked.exactScope).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
