import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureLegacyDetails } from "./capture-legacy-details.ts";
import { hasExactLegacyDetailIdentity } from "./legacy-coverage.ts";
import { planLegacyDetailQueue } from "./legacy-detail-queue.ts";

test("候选详情身份须有精确名称和可验证的嵌入 ID", () => {
  expect(hasExactLegacyDetailIdentity({ id: 3021, name: "支配遗忘" }, "3021", "支配遗忘")).toBe(true);
  expect(hasExactLegacyDetailIdentity({ id: "3021", name: "支配遗忘" }, "3021", "支配遗忘")).toBe(true);
  for (const invalid of [{ id: "03021", name: "支配遗忘" }, { id: 3020, name: "支配遗忘" }, { id: 3021 },
    { id: 3021, name: "支配遗忘 " }, [{ id: 3021, name: "支配遗忘" }]]) {
    expect(hasExactLegacyDetailIdentity(invalid, "3021", "支配遗忘")).toBe(false);
  }
  expect(hasExactLegacyDetailIdentity({ id: 3513447881416968543, name: "溢出" }, "3513447881416968543", "溢出")).toBe(false);
});

test("缺固定索引时拒绝生成队列、拒绝候选请求且保持目录为空", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-detail-queue-"));
  try {
    const candidate = join(root, "candidate");
    const request = async () => { throw new Error("unexpected HTTP request"); };
    await expect(planLegacyDetailQueue(root, root)).rejects.toThrow("图鉴索引未验证");
    await expect(captureLegacyDetails(root, root, candidate, { maxRequests: 9, request })).rejects.toThrow("0 到 8");
    await expect(captureLegacyDetails(root, root, candidate, { maxRequests: 1, request })).rejects.toThrow("分开保存");
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
