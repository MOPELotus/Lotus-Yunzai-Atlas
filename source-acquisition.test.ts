import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtlasRuntimeCatalog, findBangboos } from "./catalog.ts";
import { publishAtlasCandidate } from "./publish-candidate.ts";
import { acquireAtlasSource } from "./source-acquisition.ts";

const version = "3.4.4+20539349";
const scope = [{ game: "zzz", pageId: "bangboo", version, recordCount: 3 }] as const;
const listUrl = `https://static.nanoka.cc/zzz/${version}/bangboo.json`;
const makeDetailUrl = (id: number) => `https://static.nanoka.cc/zzz/${version}/zh/bangboo/${id}.json`;
const icon = "UI/Sprite/A1DynamicLoad/BangbooModGarage/UnPacker/BangbooRole/Fixture123.png";
const iconUrl = "https://static.nanoka.cc/assets/zzz/Fixture123.webp";
const fullIconUrl = `https://static.nanoka.cc/assets/zzz/${icon.slice(0, -4)}.webp`;
const imagePath = "gallery/zzz/Fixture123.webp";
const placeholderPath = "gallery/_placeholder/unknown.svg";
const legacyPlaceholderHash = "25fe1ba8bf237af8dc0157859efb518fa04c23b8e55ca4c05ec8292eebc2122e";
const webp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
const index = {
  "53001": { zh: "样例邦布甲", rank: 3, icon },
  "53002": { zh: "样例邦布乙", rank: 4, icon },
  "53003": { zh: "样例邦布丙", rank: 3, icon: "" },
};

function detail(id: 53001 | 53002) {
  const list = index[id];
  return { id, name: list.zh, rarity: list.rank, icon };
}

function source(url: string): Response {
  if (url === listUrl) return Response.json(index);
  if (url === makeDetailUrl(53001)) return Response.json(detail(53001));
  if (url === makeDetailUrl(53002)) return Response.json(detail(53002));
  if (url === makeDetailUrl(53003)) return new Response(null, { status: 404 });
  if (url === iconUrl) return new Response(new Uint8Array(webp), { headers: { "Content-Type": "image/webp" } });
  throw new Error(`unexpected URL ${url}`);
}

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-acquire-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("绝区零邦布抓取固定版本、复用同图并输出可验证和发布的完整分类", () => fixture(async (root) => {
  const snapshots = join(root, "snapshots");
  await mkdir(snapshots);
  const candidate = join(snapshots, "1");
  const requests: string[] = [];
  const acquired = await acquireAtlasSource(candidate, scope, undefined, async (url, options) => {
    requests.push(url);
    expect(options).toMatchObject({ redirect: "error", credentials: "omit" });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    return source(url);
  });
  expect(requests).toEqual([listUrl, makeDetailUrl(53001), iconUrl, makeDetailUrl(53002), makeDetailUrl(53003)]);
  expect(acquired).toEqual({ directory: candidate, pages: scope, imageCount: 1, missingImageCount: 0 });
  expect(await readFile(join(candidate, imagePath))).toEqual(webp);
  const data = join(candidate, "data");
  const map = await Bun.file(join(data, "map.json")).json();
  const page = map.games.zzz.locales.zh.pages.bangboo;
  expect(page).toMatchObject({ sampled: false, recordCount: 3, totalRecordCount: 3, sourceUrl: listUrl });
  const image = { status: "downloaded", placeholder: false, localPath: imagePath,
    remoteUrl: iconUrl, sha256: createHash("sha256").update(webp).digest("hex"), originalValue: icon };
  const withDetail = await Bun.file(join(data, page.records[53001].path)).json();
  expect(withDetail).toMatchObject({ meta: { hasDetail: true, images: [
    { ...image, fieldPath: "icon" }, { ...image, fieldPath: "detail.icon" },
  ] }, content: { detail: detail(53001) } });
  const withoutDetail = await Bun.file(join(data, page.records[53003].path)).json();
  expect(withoutDetail).toMatchObject({ meta: { hasDetail: false, images: [] }, content: { detail: null } });
  expect(await publishAtlasCandidate(root, null, 1, scope)).toMatchObject({ status: "published", directory: data });
  const catalog = createAtlasRuntimeCatalog(root);
  const [found] = findBangboos(await catalog.read(), "样例邦布乙");
  expect(found).toMatchObject({ name: "样例邦布乙", version });
  expect(await catalog.bangbooRarity(found!)).toBe("S级");
}));

test("先检查扁平图标，再检查完整素材路径，双缺失仍输出完整分类", () => fixture(async (root) => {
  const fallback = join(root, "fallback");
  const absent = join(root, "absent");
  const requests: string[] = [];
  for (const [directory, available] of [[fallback, true], [absent, false]] as const) {
    const acquired = await acquireAtlasSource(directory, scope, undefined, async (url) => {
      requests.push(url);
      if (url === iconUrl) return new Response(null, { status: 404 });
      if (url === fullIconUrl) return available ? source(iconUrl) : new Response(null, { status: 404 });
      return source(url);
    });
    expect(acquired).toMatchObject({ imageCount: available ? 1 : 0, missingImageCount: available ? 0 : 1 });
    expect(await Bun.file(join(directory, imagePath)).exists()).toBe(available);
    const item = await Bun.file(join(directory, "data/items/zh/zzz/bangboo/53001.json")).json();
    const placeholder = { status: "placeholder", placeholder: true, placeholderReason: "remote_missing",
      localPath: placeholderPath, sha256: legacyPlaceholderHash };
    expect(item.meta.images).toMatchObject(available ? [
      { fieldPath: "icon", status: "downloaded", remoteUrl: fullIconUrl, localPath: imagePath },
      { fieldPath: "detail.icon", status: "downloaded", remoteUrl: fullIconUrl, localPath: imagePath },
    ] : [
      { fieldPath: "icon", ...placeholder }, { fieldPath: "detail.icon", ...placeholder },
    ]);
  }
  expect(createHash("sha256").update(await readFile(join(absent, placeholderPath))).digest("hex")).toBe(legacyPlaceholderHash);
  expect(requests.filter((url) => url === iconUrl || url === fullIconUrl)).toEqual([iconUrl, fullIconUrl, iconUrl, fullIconUrl]);
  await mkdir(join(root, "snapshots"));
  await rename(absent, join(root, "snapshots", "1"));
  expect(await publishAtlasCandidate(root, null, 1, scope)).toMatchObject({ status: "published" });
}));

test("抓取拒绝无关范围，并在来源身份、图标或连接错误时清理候选", () => fixture(async (root) => {
  const candidate = join(root, "candidate");
  let count = 0;
  const request = async (url: string) => { count++; return source(url); };
  await expect(acquireAtlasSource(candidate, [{ game: "gi", pageId: "weapon", version }], undefined, request)).rejects.toThrow();
  await expect(acquireAtlasSource(candidate, [{ ...scope[0], version: "../../invalid" }], undefined, request)).rejects.toThrow();
  expect(count).toBe(0);
  await expect(acquireAtlasSource(candidate, scope, undefined, async (url) => url === makeDetailUrl(53002)
    ? Response.json({ ...detail(53002), id: 7 }) : source(url))).rejects.toThrow("身份或等级不符");
  expect(await Bun.file(join(candidate, imagePath)).exists()).toBe(false);
  await expect(acquireAtlasSource(candidate, scope, undefined, async (url) => url === iconUrl
    ? new Response("invalid image/webp") : source(url))).rejects.toThrow("WebP");
  await expect(acquireAtlasSource(candidate, scope, undefined, async (url) => url === iconUrl
    ? new Response(null, { status: 503 }) : source(url))).rejects.toThrow("HTTP 503");
  expect((await acquireAtlasSource(candidate, scope, undefined, request)).imageCount).toBe(1);
}));
