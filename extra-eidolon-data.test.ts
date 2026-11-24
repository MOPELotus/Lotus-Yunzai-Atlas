import { expect, test } from "bun:test";
import type { Game } from "./catalog.ts";
import { normalizeExtraEidolons, readBuiltinExtraEidolons } from "./extra-eidolon-data.ts";

const identity = (id: string, name: string, game: Game = "hsr") => ({
  game, id, overview: { name, rarity: "五星", facts: [] },
});

test("静态奇缘星魂独立保留名称、倍率和换行，角色身份不符时拒绝拼接", () => {
  const role = identity("1204", "景元");
  const metadata = { id: 1204, name: "景元", exCons: {
    "1": { name: "万钧入盏，风静灯明", desc: "提高<nobr>240.0%</nobr>。<br />持续4回合。" },
    bad: { name: "无效序号", desc: "不显示" },
    "2": { name: "缺少原描述" },
  } };
  expect(normalizeExtraEidolons(role, metadata)).toEqual([
    { rank: 1, name: "万钧入盏，风静灯明", description: "提高240.0%。\n持续4回合。" },
  ]);
  for (const other of [identity("1308", "景元"), identity("1204", "黄泉"), identity("1204", "景元", "gi")]) {
    expect(normalizeExtraEidolons(other, metadata)).toEqual([]);
  }
  expect(normalizeExtraEidolons(role, { ...metadata, exCons: undefined })).toEqual([]);
});

test("实际内置三角色奇缘详情和原图均可供百科使用，不要求用户面板激活", async () => {
  for (const [id, name, title] of [
    ["1204", "景元", "万钧入盏，风静灯明"],
    ["1213", "丹恒·饮月", "沧溟间，月落潮平"],
    ["1308", "黄泉", "虚隙一顾…枯骨眠霜"],
  ]) {
    const extra = await readBuiltinExtraEidolons(identity(id!, name!));
    expect(extra.entries).toHaveLength(1);
    expect(extra.entries[0]?.name).toBe(title);
    expect(extra.entries[0]?.description).not.toMatch(/<[^>]+>/u);
    expect(extra.entries[0]?.description).toContain(name === "黄泉" ? "300.0%" : "240.0%");
    expect(extra.icon?.subarray(8, 12).toString()).toBe("WEBP");
  }
  expect(await readBuiltinExtraEidolons(identity("1001", "三月七"))).toEqual({ entries: [] });
  expect(await readBuiltinExtraEidolons(identity("1204", "../景元"))).toEqual({ entries: [] });
});
