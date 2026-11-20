import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { atlasThemeDirectories } from "./theme-directories.ts";

test("图鉴主题按宿主持久目录、模块目录、两种旧部署的顺序查找", () => {
  const checkout = new URL("./fixture/", import.meta.url);
  const module = new URL("plugins/atlas/role-render.ts", checkout);
  const expected = [
    "data/atlas/theme",
    "plugins/atlas/assets/miao-theme",
    "plugins/Lotus-ReFactor/resources/miao-theme",
    "plugins/Lotus-Plugin/resources/miao-theme",
  ].map((directory) => fileURLToPath(new URL(directory, checkout)));
  expect(atlasThemeDirectories(module)).toEqual(expected);
  expect(atlasThemeDirectories(module.href, "  ")).toEqual(expected);
});

test("显式图鉴主题配置先于默认目录，并只使用所选主题", () => {
  expect(atlasThemeDirectories(import.meta.url, "  /operator/original-theme  ")).toEqual(["/operator/original-theme"]);
});
