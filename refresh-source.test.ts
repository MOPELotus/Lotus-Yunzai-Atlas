import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtlasRuntimeCatalog, findBangboos } from "./catalog.ts";
import { publishAtlasCandidate, readAtlasSnapshotVersion } from "./publish-candidate.ts";
import { refreshAtlasSource } from "./refresh-source.ts";
import { acquireAtlasSource } from "./source-acquisition.ts";

const original = "3.4.4+20539349";
const upgrade = "3.4.4+20539350";
const scope = (version: string) => [{ game: "zzz", pageId: "bangboo", version, recordCount: 1 }] as const;
const icon = "UI/Sprite/A1DynamicLoad/BangbooModGarage/UnPacker/BangbooRole/Fixture.png";
const webp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
const missing = () => new Response(null, { status: 404 });
const manifest = (version: string) => async () => ({ zzz: { latest: version, available: [version] } });

function source(version: string, available: "all" | "detail-missing" | "icon-missing" = "all") {
  const name = `样例邦布 ${version}`;
  return async (url: string) => {
    if (url === `https://static.nanoka.cc/zzz/${version}/bangboo.json`) return Response.json({ "53001": { zh: name, rank: 3, icon } });
    if (url === `https://static.nanoka.cc/zzz/${version}/zh/bangboo/53001.json`) {
      return available === "detail-missing" ? missing() : Response.json({ id: 53001, name, rarity: 3, icon });
    }
    if (url.startsWith("https://static.nanoka.cc/assets/zzz/") && url.endsWith("Fixture.webp")) {
      return available === "icon-missing" ? missing() : new Response(new Uint8Array(webp));
    }
    throw new Error(`意外的来源夹具请求 ${url}`);
  };
}

async function fixture(run: (workspace: string, root: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "lotus-atlas-refresh-fixture-"));
  const root = join(workspace, "atlas");
  try {
    await acquireAtlasSource(root, scope(original), undefined, source(original));
    await run(workspace, root);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("邦布自动刷新按计划抓取较新构建并发布完整候选", () => fixture(async (workspace, root) => {
  const catalog = createAtlasRuntimeCatalog(root);
  const [old] = findBangboos(await catalog.read(), "53001");
  const result = await refreshAtlasSource(root, { manifest: manifest(upgrade), request: source(upgrade) });
  expect(result).toEqual({ status: "published", version: 1, directory: join(root, "snapshots/1/data") });
  const [updated] = findBangboos(await catalog.read(), "53001");
  expect(updated?.version).toBe(upgrade);
  expect(catalog.assetRoot(updated!)).toBe(join(root, "snapshots/1/data"));
  expect(catalog.assetRoot(old!)).toBe(join(root, "data"));
  expect(await readdir(workspace)).toEqual(["atlas"]);
}));

test("同版本、不明版本及缺失旧基线都不请求邦布详情", () => fixture(async (workspace, root) => {
  let calls = 0;
  const request = async () => { calls++; return missing(); };
  expect(await refreshAtlasSource(root, { manifest: manifest(original), request })).toEqual({ status: "current", version: original });
  expect(await refreshAtlasSource(root, { manifest: manifest("3.4.4"), request })).toEqual({ status: "review", reason: "unproven-upgrade" });
  expect(await refreshAtlasSource(root, { manifest: async () => ({}), request })).toEqual({ status: "review", reason: "manifest-unavailable" });
  expect(await refreshAtlasSource(join(workspace, "missing"), { manifest: manifest(upgrade), request }))
    .toEqual({ status: "review", reason: "local-unverified" });
  await rename(join(root, "data/map.json"), join(root, "map-before.json"));
  expect(await refreshAtlasSource(root, { manifest: manifest(upgrade), request }))
    .toEqual({ status: "review", reason: "local-unverified" });
  expect(calls).toBe(0);
  expect(await readAtlasSnapshotVersion(root)).toBeNull();
  expect(await readdir(workspace)).toEqual(["atlas"]);
}));

test("404 使同 ID 现有详情或任一已下载图标缺失时拒绝发布", () => fixture(async (workspace, root) => {
  const detail = await refreshAtlasSource(root, { manifest: manifest(upgrade), request: source(upgrade, "detail-missing") });
  expect(detail).toEqual({ status: "invalid", issues: ["邦布 53001 缺少已有详情。", "邦布 53001 缺少已下载图标 detail.icon。"] });
  const media = await refreshAtlasSource(root, { manifest: manifest(upgrade), request: source(upgrade, "icon-missing") });
  expect(media).toEqual({ status: "invalid", issues: ["邦布 53001 缺少已下载图标 icon。", "邦布 53001 缺少已下载图标 detail.icon。"] });
  expect(await readAtlasSnapshotVersion(root)).toBeNull();
  expect(await readdir(workspace)).toEqual(["atlas"]);
}));

test("收集期间已发布较新指针时提前结束，保持竞争赢家", () => fixture(async (workspace, root) => {
  await mkdir(join(root, "snapshots"));
  await acquireAtlasSource(join(root, "snapshots/4"), scope(original), undefined, source(original));
  const collect = source(upgrade);
  let switched = false;
  const result = await refreshAtlasSource(root, { manifest: manifest(upgrade), request: async (url) => {
    if (!switched) {
      switched = true;
      expect((await publishAtlasCandidate(root, null, 4, scope(original))).status).toBe("published");
    }
    return collect(url);
  } });
  expect(result).toEqual({ status: "stale", current: 4 });
  expect(await readAtlasSnapshotVersion(root)).toBe(4);
  expect(await readdir(join(root, "snapshots"))).toEqual(["4"]);
  expect(await readdir(workspace)).toEqual(["atlas"]);
}));
