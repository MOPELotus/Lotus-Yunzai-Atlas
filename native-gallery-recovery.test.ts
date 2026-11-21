import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readlink, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAtlasCandidate } from "./apply-candidate.ts";
import { downloadAtlasVersion } from "./download-legacy-atlas.ts";
import { atlasSourceOrigin, type AtlasSourceFetch } from "./source-transport.ts";

const bytes = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
const checksum = createHash("sha256").update(bytes).digest("hex");
const damaged = Buffer.from(bytes).fill(0, 25, 27);
const artwork = "UI_EquipIcon_Sword_Zephyrus";
const assetPath = `/assets/gi/${artwork}.webp`;
const localPath = `gallery/gi/${artwork}.webp`;
const indexPath = "/gi/7.2/weapon.json";
const selection = [{ game: "gi", pageId: "weapon" }] as const;

async function saveWeapon(root: string, url = atlasSourceOrigin + assetPath) {
  const row = { zh: "西风剑", icon: artwork, rank: 4, type: "sword" };
  const entry = { id: "11401", name: "西风剑", hasDetail: true, path: "items/weapon.json" };
  const weapon = { id: "weapon", version: "7.2", recordCount: 1, totalRecordCount: 1, sampled: false,
    records: { [entry.id]: entry } };
  await mkdir(join(root, "data", "items"), { recursive: true });
  await Bun.write(join(root, "data", "map.json"), JSON.stringify({
    games: { gi: { locales: { zh: { pages: { weapon } } } } },
  }));
  await Bun.write(join(root, "data", entry.path), JSON.stringify({
    meta: { gameId: "gi", pageId: "weapon", version: "7.2", locale: "zh",
      recordId: entry.id, name: entry.name, hasDetail: true,
      images: [{ fieldPath: "icon", status: "downloaded", placeholder: false, localPath, remoteUrl: url, sha256: checksum }] },
    content: { list: row, detail: { name: entry.name, icon: artwork } },
  }));
  return { row, file: join(root, localPath) };
}

test("同版源缺图或同尺寸损坏时只补原图，健康和已有的下载缓存无额外原图请求", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-native-image-recovery-"));
  try {
    const target = join(root, "target");
    const original = join(target, "snapshots", "1");
    const data = join(original, "data");
    const { row, file } = await saveWeapon(original);
    await Bun.write(file, bytes);
    await symlink("snapshots/1/data", join(target, "current"));
    const requests: string[] = [];
    let remote = bytes;
    const request: AtlasSourceFetch = async (url, options) => {
      const path = new URL(url).pathname;
      requests.push(path);
      expect(options.credentials).toBe("omit");
      expect(options.redirect).toBe("error");
      if (path === indexPath) return Response.json({ "11401": row });
      if (path === assetPath) return new Response(remote);
      throw new Error(`不应重读 ${url}`);
    };
    const workspace = join(root, "work");
    const download = (consume = async (candidate: string) => {
      expect(Buffer.from(await Bun.file(join(candidate, localPath)).arrayBuffer())).toEqual(bytes);
      expect(await Bun.file(join(candidate, "data/items/weapon.json")).text())
        .toBe(await Bun.file(join(data, "items/weapon.json")).text());
    }) => downloadAtlasVersion(workspace, target, { gi: "7.2" }, consume, undefined, request, selection, data);

    await download();
    expect(requests.splice(0)).toEqual([indexPath]);
    await unlink(file);
    remote = damaged;
    await expect(download()).rejects.toThrow("原资源字节校验失败");
    expect(requests.splice(0)).toEqual([indexPath, assetPath]);
    expect(await readlink(join(target, "current"))).toBe("snapshots/1/data");
    expect(await Bun.file(file).exists()).toBeFalse();

    remote = bytes;
    await download();
    expect(requests.splice(0)).toEqual([indexPath, assetPath]);
    expect(await Bun.file(file).exists()).toBeFalse();
    await Bun.write(file, damaged);
    await download();
    expect(requests.splice(0)).toEqual([indexPath]);
    expect(Buffer.from(await Bun.file(file).arrayBuffer())).toEqual(damaged);

    const promote = await downloadAtlasVersion(workspace, target, { gi: "7.2" },
      (candidate, pages) => applyAtlasCandidate(target, candidate, pages), undefined, request, selection, data);
    expect(promote.status).toBe("published");
    expect(await readlink(join(target, "current"))).toBe("snapshots/2/data");
    expect(Buffer.from(await Bun.file(join(target, "snapshots", "2", localPath)).arrayBuffer())).toEqual(bytes);
    expect(Buffer.from(await Bun.file(file).arrayBuffer())).toEqual(damaged);
    expect(requests).toEqual([indexPath]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("旧下载断点可作为同版来源，补取仍限定对应游戏的原站", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-native-legacy-recovery-"));
  try {
    const target = join(root, "target");
    const work = join(root, "work");
    const backend = join(work, "backend");
    await mkdir(target);
    const { row, file } = await saveWeapon(backend, "https://untrusted.example/icon.webp");
    const requests: string[] = [];
    const request: AtlasSourceFetch = async (url) => {
      requests.push(url);
      if (url === atlasSourceOrigin + assetPath) return new Response(bytes);
      return Response.json({ "11401": row });
    };
    const run = () => downloadAtlasVersion(work, target, { gi: "7.2" }, async () => {
      throw new Error("失败图不应进入发布");
    }, undefined, request, selection);
    await expect(run()).rejects.toThrow("对应游戏的 Nanoka CDN");
    expect(requests.splice(0)).toEqual([atlasSourceOrigin + indexPath]);
    expect(await Bun.file(file).exists()).toBeFalse();

    await saveWeapon(backend);
    await downloadAtlasVersion(work, target, { gi: "7.2" }, async (candidate) => {
      expect(Buffer.from(await Bun.file(join(candidate, localPath)).arrayBuffer())).toEqual(bytes);
    }, undefined, request, selection);
    expect(requests).toEqual([atlasSourceOrigin + indexPath, atlasSourceOrigin + assetPath]);
    expect(await Bun.file(file).exists()).toBeFalse();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
