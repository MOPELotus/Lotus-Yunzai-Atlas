export const atlasSourceOrigin = "https://static.nanoka.cc";
export type AtlasSourceFetch = (url: string, options: RequestInit) => Promise<Response>;

const requestTimeout = 10_000;

export async function readAtlasSourceBytes(url: string, accept: string, limit: number, optional: boolean,
  signal: AbortSignal | undefined, request: AtlasSourceFetch): Promise<Buffer | undefined> {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(requestTimeout);
  const response = await request(url, {
    redirect: "error", credentials: "omit", headers: { Accept: accept },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    if (optional && response.status === 404) return;
    throw new Error(`图鉴来源读取失败（HTTP ${response.status}）。`);
  }
  const reader = response.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("图鉴来源文件超出大小上限。");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
