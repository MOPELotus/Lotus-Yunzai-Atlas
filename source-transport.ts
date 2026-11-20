export const atlasSourceOrigin = "https://static.nanoka.cc";
export type AtlasSourceFetch = (url: string, options: RequestInit) => Promise<Response>;

const requestTimeout = 10_000;
const retryableStatus = new Set([408, 500, 502, 503, 504]);

class AtlasReadFailure extends Error {}

export function isAtlasSourceWebp(bytes: Buffer): boolean {
  return bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.readUInt32LE(4) === bytes.length - 8 &&
    bytes.toString("ascii", 8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16)) &&
    bytes.readUInt32LE(16) <= bytes.length - 20;
}

export async function readAtlasSourceBytes(url: string, accept: string, limit: number, optional: boolean,
  signal: AbortSignal | undefined, request: AtlasSourceFetch, options?: { readonly retry?: boolean }): Promise<Buffer | undefined> {
  const timeout = AbortSignal.timeout(requestTimeout);
  const active = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const attempts = options?.retry ? 3 : 1;
  for (let attempt = 1; ; attempt++) {
    active.throwIfAborted();
    try {
      return await readResponse(url, accept, limit, optional, active, request);
    } catch (error) {
      active.throwIfAborted();
      if (attempt === attempts || error instanceof AtlasReadFailure) throw error;
      await Bun.sleep(attempt * 125);
    }
  }
}

async function readResponse(url: string, accept: string, limit: number, optional: boolean,
  signal: AbortSignal, request: AtlasSourceFetch): Promise<Buffer | undefined> {
  const response = await request(url, {
    redirect: "error", credentials: "omit", headers: { Accept: accept },
    signal,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    if (optional && response.status === 404) return;
    const detail = `图鉴来源读取失败（HTTP ${response.status}）。`;
    throw retryableStatus.has(response.status) ? new Error(detail) : new AtlasReadFailure(detail);
  }
  const reader = response.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new AtlasReadFailure("图鉴来源文件超出大小上限。");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
