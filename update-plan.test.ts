import { expect, test } from "bun:test";
import { planAtlasUpdate, type AtlasPlanPage } from "./update-plan.ts";
import type { AtlasCandidateValidation } from "./validate-candidate.ts";

const gi = { game: "gi", pageId: "character" } as const;
const hsr = { game: "hsr", pageId: "lightcone" } as const;
const zzz = { game: "zzz", pageId: "bangboo" } as const;
const stage = { game: "gi", pageId: "tower" } as const;
const source = {
  gi: { latest: "7.2.52", available: ["7.2", "7.2.52"], live: "7.2", new: { character: [] } },
  hsr: { latest: "4.7.52", available: ["4.7.52"] },
  zzz: { latest: "3.4.4+20539349", available: ["3.4.4+20539349"] },
  ww: { latest: "3.8", available: ["3.8"] },
};

function local(...rows: readonly (AtlasPlanPage & { readonly version: string })[]): AtlasCandidateValidation {
  return { ok: true, issueCount: 0, issues: [], pages: rows.map((page) => ({ ...page, recordCount: 10 })) };
}

test("图鉴按分类比较版本与构建号，挑战轮换单列并保留现有版本", () => {
  const snapshot = local({ ...gi, version: "7.2" }, { ...hsr, version: "4.7.52" },
    { ...zzz, version: "3.4.4+20492413" }, { ...stage, version: "7.2.52" });
  const plan = planAtlasUpdate(source, snapshot, [gi, hsr, zzz, stage]);
  expect(plan.entries).toEqual([
    { ...gi, kind: "versioned", action: "fetch", localVersion: "7.2", targetVersion: "7.2.52" },
    { ...stage, kind: "challenge", action: "audit-rotation", localVersion: "7.2.52" },
    { ...hsr, kind: "versioned", action: "current", localVersion: "4.7.52", targetVersion: "4.7.52" },
    { ...zzz, kind: "versioned", action: "fetch", localVersion: "3.4.4+20492413", targetVersion: "3.4.4+20539349" },
  ]);
  expect(plan.candidateRequirements).toEqual([{ ...gi, version: "7.2.52" }, { ...zzz, version: "3.4.4+20539349" }]);
});

test("不自动降级或猜测未知版本，清单中无法验证的游戏单独待审核", () => {
  for (const version of ["7.2.53", "7.2.52.0", "7.2.51-preview", "7.2.51+1"]) {
    const plan = planAtlasUpdate(source, local({ ...gi, version }), [gi]);
    expect(plan.entries).toEqual([{ ...gi, kind: "versioned", action: "review", reason: "unproven-upgrade",
      targetVersion: "7.2.52", localVersion: version }]);
    expect(plan.candidateRequirements).toEqual([]);
  }
  const partialSource = { ...source, gi: { latest: "7.2.52", available: ["7.2"] } };
  const plan = planAtlasUpdate(partialSource, undefined, [gi, hsr, zzz, stage]);
  expect(plan.entries.slice(0, 2)).toEqual([
    { ...gi, kind: "versioned", action: "review", reason: "manifest-unavailable" },
    { ...stage, kind: "challenge", action: "audit-rotation" },
  ]);
  expect(plan.candidateRequirements).toEqual([{ ...hsr, version: "4.7.52" }, { ...zzz, version: "3.4.4+20539349" }]);
});

test("无效本地快照和未知分类不会被当作空目录初始化", () => {
  const invalid = { ...local({ ...gi, version: "7.2" }), ok: false, issueCount: 1, issues: ["候选无效"] };
  const plan = planAtlasUpdate(source, invalid, [gi, hsr, stage]);
  expect(plan.candidateRequirements).toEqual([]);
  expect(plan.entries.map((item) => item.action)).toEqual(["review", "audit-rotation", "review"]);
  expect(() => planAtlasUpdate(source, undefined, [{ ...gi, pageId: "unknown" }])).toThrow("未识别");
});
