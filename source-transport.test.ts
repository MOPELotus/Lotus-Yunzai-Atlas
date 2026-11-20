import { expect, test } from "bun:test";
import { atlasSourceOrigin, readAtlasSourceBytes } from "./source-transport.ts";

const url = `${atlasSourceOrigin}/manifest.json`;

test("正式来源瞬断或响应体中断会重读完整文件", async () => {
  const signals: AbortSignal[] = [];
  const chunk = new TextEncoder().encode("不完整");
  const bytes = await readAtlasSourceBytes(url, "application/json", 64, false, undefined, async (address, options) => {
    expect(address).toBe(url);
    expect(options).toMatchObject({ redirect: "error", credentials: "omit", headers: { Accept: "application/json" } });
    signals.push(options.signal!);
    if (signals.length === 1) throw new TypeError("connection reset");
    if (signals.length === 2) {
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(chunk); },
        pull(controller) { controller.error(new TypeError("connection closed while reading")); },
      }));
    }
    return Response.json({ version: 1 });
  }, { retry: true });
  expect(bytes?.toString()).toBe('{"version":1}');
  expect(signals).toHaveLength(3);
  expect(new Set(signals).size).toBe(1);
});

test("保留来源的请求上限、404、限流和大小限制", async () => {
  for (const [status, optional, expected] of [[404, true, 1], [429, false, 1], [503, false, 3]] as const) {
    let attempts = 0;
    const result = readAtlasSourceBytes(url, "application/json", 8, optional, undefined, async () => {
      attempts++;
      return new Response(null, { status });
    }, { retry: true });
    if (optional) expect(await result).toBeUndefined();
    else await expect(result).rejects.toThrow(`HTTP ${status}`);
    expect(attempts).toBe(expected);
  }

  let attempts = 0;
  await expect(readAtlasSourceBytes(url, "application/json", 1, false, undefined, async () => {
    attempts++;
    return Response.json({});
  }, { retry: true })).rejects.toThrow("大小上限");
  expect(attempts).toBe(1);

  attempts = 0;
  await expect(readAtlasSourceBytes(url, "application/json", 8, false, undefined, async () => {
    attempts++;
    throw new TypeError("record attempt");
  })).rejects.toThrow("record attempt");
  expect(attempts).toBe(1);
});

test("宿主停止后不会继续重试来源", async () => {
  const lifecycle = new AbortController();
  let attempts = 0;
  await expect(readAtlasSourceBytes(url, "application/json", 8, false, lifecycle.signal, async () => {
    attempts++;
    setTimeout(() => lifecycle.abort(new Error("fixture stop")), 20);
    return new Response(null, { status: 503 });
  }, { retry: true })).rejects.toThrow("fixture stop");
  expect(attempts).toBe(1);
});
