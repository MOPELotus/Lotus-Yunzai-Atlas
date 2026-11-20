import { expect, test } from "bun:test";
import { parseAtlasUpdatePolicy } from "./update-policy.ts";

test("明确的旧图鉴配置沿用两种周期，新部署只启用手动", () => {
  const unconfigured = parseAtlasUpdatePolicy(undefined);
  expect(unconfigured.version.cron).toBeUndefined();
  expect(unconfigured.challenge.cron).toBeUndefined();
  expect(unconfigured.version.selections).toHaveLength(16);
  const legacy = parseAtlasUpdatePolicy({});
  expect(legacy.version.cron).toBe("0 0 */6 * * *");
  expect(legacy.challenge.cron).toBe("0 15 */2 * * *");
  expect(legacy.challenge.selections).toEqual(["zzz/boss", "zzz/shiyu"]);
  const disabled = parseAtlasUpdatePolicy({ auto_update: { enable: false } });
  expect(disabled.version.cron).toBeUndefined();
  expect(disabled.challenge.cron).toBeUndefined();
  expect(disabled.version.selections).toEqual(legacy.version.selections);
});

test("旧 game 和 page 取交集，只选已核实分类，分别保留两个任务的范围", () => {
  const { version, challenge } = parseAtlasUpdatePolicy({
    update_args: ["src/scrape.mjs", "--mode", "incremental", "--game=gi,zzz", "--locales", "zh-cn,en",
      "--page", "hsr=lightcone;zzz:bangboo,character", "--pages=gi=weapon,artifact", "--page=zzz=boss"],
    challenge_args: ["--incremental", "--game", "hsr,zzz", "--page", "zzz=shiyu,monster;hsr=maze"],
    selected_pages: { zzz: ["equipment"] },
  });
  expect(version.selections).toEqual(["zzz/bangboo", "gi/artifact", "gi/weapon", "zzz/boss"]);
  expect(challenge.selections).toEqual(["zzz/shiyu"]);
  const noChinese = parseAtlasUpdatePolicy({ update_args: ["--locale", "ja"] });
  expect(noChinese.version.selections).toEqual([]);
  expect(noChinese.version.cron).toBeUndefined();
});

test("不能等价转换的 cron、旧外部命令和版本或样本选项不会扩大范围", () => {
  const jobs = parseAtlasUpdatePolicy({ auto_update: {
    check_cron: "5 1 * * MON-FRI", challenge_cron: "0 15 */2 * * ? 2026",
  } });
  expect(jobs.version.cron).toBe("0 5 1 * * MON-FRI");
  expect(jobs.challenge).toMatchObject({ issue: expect.stringContaining("challenge_cron") });
  expect(jobs.challenge.cron).toBeUndefined();
  expect(parseAtlasUpdatePolicy({ auto_update: { check_cron: "0 0 9 ? * MON-FRI *" } }).version.cron).toBe("0 0 9 * * MON-FRI");
  expect(parseAtlasUpdatePolicy({ auto_update: { check_cron: "0 0 9 ? * 1-5 *" } }).version.cron).toBeUndefined();
  for (const check_cron of ["60 0 */6 * * ? *", "0 0 9 */0 * *", "0 0 9 ? MAYBE MON *"]) {
    expect(parseAtlasUpdatePolicy({ auto_update: { check_cron } }).version).toMatchObject({ issue: expect.stringContaining("check_cron") });
  }
  for (const update_args of [["--version", "zzz=3.4.4"], ["--sample"], ["--mode=full"],
    ["--page"], ["--no-images"], ["--game", "--locale"], ["run-local.sh"]]) {
    expect(parseAtlasUpdatePolicy({ update_args }).version).toMatchObject({ selections: [], issue: expect.stringContaining("update_args") });
  }
});
