import { expect, test } from "bun:test";
import { reportAtlasInitializationProgress } from "./initialization-progress.ts";

test("进度观察者可同步或异步失败，取消后不再通知", async () => {
  const event = { stage: "download", message: "record", completed: 1, total: 2 };
  await expect(reportAtlasInitializationProgress(() => { throw new Error("sync sink"); }, event)).resolves.toBeUndefined();
  await expect(reportAtlasInitializationProgress(async () => { throw new Error("async sink"); }, event)).resolves.toBeUndefined();
  const controller = new AbortController();
  let calls = 0;
  const callback = () => { calls++; controller.abort(); };
  await reportAtlasInitializationProgress(callback, event, controller.signal);
  await reportAtlasInitializationProgress(callback, event, controller.signal);
  expect(calls).toBe(1);
});
