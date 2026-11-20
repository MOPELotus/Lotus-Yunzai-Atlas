// Loaded by the pinned exporter process. Its built-in requests are anonymous and never follow redirects.
const origins = new Set([
  "https://static.nanoka.cc",
  "https://gi.nanoka.cc",
  "https://hsr.nanoka.cc",
  "https://zzz.nanoka.cc",
]);

const request = globalThis.fetch;
globalThis.fetch = function publicAtlasFetch(input, init) {
  const url = new URL(input instanceof Request ? input.url : input);
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (!origins.has(url.origin) || url.username || url.password || (method !== "GET" && method !== "HEAD")) {
    throw new Error("图鉴下载仅允许从三款游戏的固定 Nanoka 来源读取。");
  }
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.delete("authorization");
  headers.delete("cookie");
  return request(input, { ...init, method, headers, credentials: "omit", redirect: "error" });
};
