import { expect, test } from "bun:test";
import { setImageRenderPreset } from "@lotus-yunzai/skia";
import { atlasBookReply } from "./book-reply.ts";

const pages = (sizes: readonly number[]) => sizes.map((size, index) => ({
  section: ["总览", "技能", "命座", "培养"][index] ?? `原分页 ${index+1}`,
  png: new Uint8Array(size).fill(index + 1),
}));

test("聚合超限只重画相同原页，二倍够用仍返回一份转发", async () => {
  const scales: number[] = [];
  const value = await atlasBookReply("冰空", async scale => {
    scales.push(scale);
    return pages(scale === 4 ? [7, 6, 2, 2] : [5, 3, 1, 1]);
  }, { inlineImageByteLimit: 16 }, true);
  expect(scales).toEqual([4, 2]);
  if (value instanceof Object && value.type === "forward") {
    expect(value.nodes[0]).toBe("冰空完整图鉴\n总览 → 技能 → 命座 → 培养\n共 4 页");
    expect(value.nodes.slice(1).map(node => typeof node === "string" ? 0 : node.file.byteLength)).toEqual([5,3,1,1]);
  } else throw new Error("missing forward");
});

test("二倍整册仍超限就沿原分项继续发合并批次", async () => {
  const value = await atlasBookReply("混沌回忆", async () => pages([7,6,5,8]), { inlineImageByteLimit: 16 });
  if (value instanceof Object && value.type === "forward-image-batches") {
    expect(value.batches.map(nodes => nodes.slice(1).map(node => typeof node === "string" ? 0 : node.file[0]))).toEqual([[1,2],[3,4]]);
    expect(value.batches[0]?.[0]).toContain("共 4 页（第 1/2 段）");
    expect(value.batches[1]?.[0]).toContain("共 4 页（第 2/2 段）");
  } else throw new Error("missing batches");
});

test("整册标题按旧顺序列各分项一次，保留同分项全部页", async () => {
  const rendered = pages([7, 6, 5, 8]).map((page, index) => index === 2 ? { ...page, section: "技能" } : page);
  const value = await atlasBookReply("资料", async () => rendered);
  if (value instanceof Object && value.type === "forward") {
    expect(value.nodes[0]).toBe("资料完整图鉴\n总览 → 技能 → 培养\n共 4 页");
    expect(value.nodes.slice(1).map(node => typeof node === "string" ? 0 : node.file[0])).toEqual([1, 2, 3, 4]);
  } else throw new Error("missing forward");
});

test("只有转发节点数超限时保留四倍页，无界协议保留单份转发", async () => {
  const scales: number[] = [];
  const render = async (scale: 4 | 2 | 1) => {
    scales.push(scale);
    return pages(Array.from({ length: 101 }, () => 1));
  };
  const bounded = await atlasBookReply("资料", render, { inlineImageByteLimit: 200 });
  const unbounded = await atlasBookReply("资料", render);
  expect(scales).toEqual([4, 4]);
  expect(bounded && typeof bounded === "object" && bounded.type === "forward-image-batches" && bounded.batches.map(nodes => nodes.length)).toEqual([100,3]);
  expect(unbounded && typeof unbounded === "object" && unbounded.type === "forward" && unbounded.nodes.length).toBe(102);
});

test("低配图鉴用原有的一倍页分批，每页只渲染一次", async () => {
  const scales: number[] = [];
  setImageRenderPreset("low");
  try {
    const value = await atlasBookReply("混沌回忆", async scale => {
      scales.push(scale);
      return pages([7, 6, 5, 8]);
    }, { inlineImageByteLimit: 16 });
    expect(scales).toEqual([1]);
    expect(value && typeof value === "object" && value.type === "forward-image-batches" &&
      value.batches.map(nodes => nodes.length)).toEqual([3, 3]);
  } finally {
    setImageRenderPreset("standard");
  }
});
