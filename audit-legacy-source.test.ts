import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { auditLegacyAtlasSource, matchesLegacyAtlasIndex } from "./audit-legacy-source.ts";
import { legacyAtlasSourcePages } from "./legacy-source-profile.ts";

test("固定图鉴源清单完整列出三游戏 29 个旧索引和 6,055 条记录", () => {
  expect(legacyAtlasSourcePages).toHaveLength(29);
  expect(legacyAtlasSourcePages.reduce((sum, { recordCount }) => sum + recordCount, 0)).toBe(6055);
  expect(new Set(legacyAtlasSourcePages.map(({ indexPath }) => indexPath)).size).toBe(29);
  expect(legacyAtlasSourcePages.find(({ game, pageId }) => game === "gi" && pageId === "achievement/achievement"))
    .toMatchObject({ indexPath: "/gi/7.2.52/zh/achievement/achievement.json", indexShape: "object" });
  expect(legacyAtlasSourcePages.find(({ pageId }) => pageId === "EliteGroup"))
    .toMatchObject({ indexPath: "/hsr/4.7.52/EliteGroup.json", indexShape: "array" });
  expect(legacyAtlasSourcePages.find(({ pageId }) => pageId === "shiyu")?.indexPath).toBe("/zzz/3.4.4+20539349/shiyu.json");
});

test("索引校验检查原始字节、根结构和数量，保留超过 JS 安全整数的原始内容", () => {
  const bytes = Buffer.from('{"10000005-2":{"stage_name":3513447881416968543}}');
  const indexSha256 = createHash("sha256").update(bytes).digest("hex");
  const page = { ...legacyAtlasSourcePages[0]!, indexSha256, recordCount: 1 };
  expect(matchesLegacyAtlasIndex(page, bytes)).toBe(true);
  expect(matchesLegacyAtlasIndex(page, Buffer.from(JSON.stringify(JSON.parse(bytes.toString()))))).toBe(false);
  expect(matchesLegacyAtlasIndex({ ...page, indexShape: "array" }, bytes)).toBe(false);
  expect(matchesLegacyAtlasIndex({ ...page, recordCount: 2 }, bytes)).toBe(false);
});

test("只读审计只请求清单登记的固定版本，原响应变化和请求失败均须核对", async () => {
  const requested: string[] = [];
  const report = await auditLegacyAtlasSource({
    manifest: async () => ({
      gi: { latest: "7.3", available: ["7.3", "7.2.52"] },
      zzz: { latest: "3.4.4+20539349", available: ["3.3"] },
    }),
    async request(url, options) {
      expect(options).toMatchObject({ redirect: "error", credentials: "omit" });
      requested.push(url);
      return url.endsWith("tower.json") ? new Response(null, { status: 404 }) : Response.json({});
    },
  });
  expect(report.status).toBe("review");
  expect(report.verifiedRecordCount).toBe(0);
  expect(requested).toEqual(legacyAtlasSourcePages.filter(({ game }) => game === "gi").map(({ indexPath }) => `https://static.nanoka.cc${indexPath}`));
  expect(report.pages.filter(({ state }) => state === "version-unavailable")).toHaveLength(21);
  expect(report.pages.filter(({ state }) => state === "request-failed").map(({ pageId }) => pageId)).toEqual(["tower"]);
  expect(report.pages.filter(({ state }) => state === "content-mismatch")).toHaveLength(7);
});
