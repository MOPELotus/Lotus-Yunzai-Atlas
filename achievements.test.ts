import { expect, test } from "bun:test";
import { findAchievementCategories, findAchievements, readAchievementCategories } from "./achievements.ts";

test("同名成就保留各阶段，分类名可省略标点", () => {
  const categories = readAchievementCategories("gi", {
    version: "1", sourceUrl: "https://example.invalid/index.json", sources: [{
      id: "1", name: "测试·第一辑", list: { id: 1, name: "测试·第一辑", list: [
        { id: 10, name: "分阶段任务", desc: "第一阶段" },
        { id: 11, name: "分阶段任务", desc: "第二阶段" },
        { id: 12, name: "分阶段任务外传", desc: "外传" },
      ] },
    }],
  });
  expect(findAchievementCategories(categories, "测试第一辑").map(({ id }) => id)).toEqual(["1"]);
  expect(findAchievements(categories, "分阶段任务").map(({ entry }) => entry.id)).toEqual(["10", "11"]);
  expect(findAchievements(categories, "１１", "gi")[0]?.entry.description).toBe("第二阶段");
  expect(findAchievements(categories, "分阶段任务", "hsr")).toEqual([]);
  expect(categories[0]?.sourceUrl).toBe("https://example.invalid/index.json");
});

test("星铁成就区分百分比参数格式并处理未识别占位符", () => {
  const categories = readAchievementCategories("hsr", {
    version: "2", sourceUrl: "", sources: [{
      id: "1", name: "参数测试", list: { id: 1, name: "参数测试", list: [
        { id: 10, name: "比例", desc: "<color=#8790abff>#1% 与 <unbreak>#2[i]%</unbreak></color>", param_list: [50, 0.15] },
        { id: 11, name: "数量", desc: "收集<unbreak>#1[m]</unbreak>资源\\n<color=#000000>备注</color>", param_list: [1_000_000] },
        { id: 12, name: "缺参", desc: "使用#1[x]", param_list: [10] },
      ] },
    }],
  });
  expect(categories[0]?.entries.map(({ description }) => description)).toEqual(["50% 与 15%", "收集1000000资源\n备注", ""]);
});

test("绝区零成就按真实组号关联一级分类和子组，无法关联的快照无效", () => {
  const source = {
    version: "3", sourceUrl: "", sources: [
      { id: "category", name: "category", list: {
        "1": { name: "一级分类", group: { "1003": { name: "子组", sort: 3 } } },
      } },
      { id: "achievement", name: "achievement", list: {
        "100001": { name: "样例成就", group: 1003, desc: "解锁样例" },
      } },
      { id: "mutual_type", name: "mutual_type", list: {} },
    ],
  };
  const categories = readAchievementCategories("zzz", source);
  expect(findAchievementCategories(categories, "一级分类")[0]?.name).toBe("子组");
  expect(findAchievementCategories(categories, "一级分类 / 子组")[0]?.id).toBe("1003");
  expect(findAchievements(categories, "100001", "zzz")[0]?.entry.name).toBe("样例成就");

  const broken = { ...source, sources: source.sources.map((item) => item.id === "achievement"
    ? { ...item, list: { "100001": { name: "样例成就", group: 1007 } } } : item) };
  expect(() => readAchievementCategories("zzz", broken)).toThrow("无法关联到分类");
});
