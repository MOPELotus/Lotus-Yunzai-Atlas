import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAtlasCandidate } from "./apply-candidate.ts";
import { createAtlasRuntimeCatalog, findCharacters, findEquipment } from "./catalog.ts";
import { readAtlasSnapshotVersion, type AtlasPreparation } from "./publish-candidate.ts";
import { galleryArtwork } from "./source-values.ts";

async function fixture(run: (workspace: string, root: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "lotus-atlas-apply-fixture-"));
  const root = join(workspace, "atlas");
  try {
    await run(workspace, root);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function snapshot(root: string, version: string, pages = ["weapon"]) {
  const indexed: Record<string, unknown> = {};
  await mkdir(join(root, "data/items"), { recursive: true });
  for (const pageId of pages) {
    const id = "123";
    const name = `${pageId} ${version}`;
    const path = `items/${pageId}.json`;
    indexed[pageId] = { id: pageId, version, recordCount: 1, totalRecordCount: 1, sampled: false,
      records: { [id]: { id, name, path, hasDetail: false } } };
    await writeFile(join(root, "data", path), JSON.stringify({
      meta: { gameId: "gi", pageId, locale: "zh", recordId: id, version, name, hasDetail: false },
      content: { list: { type: "WEAPON_SWORD_ONE_HAND" }, detail: null },
    }));
  }
  await writeFile(join(root, "data/map.json"), JSON.stringify({ games: { gi: { locales: { zh: { pages: indexed } } } } }));
}

const weapon = [{ game: "gi", pageId: "weapon" }] as const;
const cli = fileURLToPath(new URL("./apply-candidate.ts", import.meta.url));

test("CLI 从旧快照更新指定分类，跳过占用编号并保留既有目录", () => fixture(async (workspace, root) => {
  const source = join(workspace, "source");
  await snapshot(root, "旧", ["weapon", "character"]);
  await snapshot(source, "新", ["weapon", "character"]);
  const versionStore = join(root, "snapshots");
  await mkdir(join(versionStore, "4"), { recursive: true });
  await writeFile(join(versionStore, "4/sentinel"), "existing");
  await symlink("missing", join(versionStore, "6"));

  const catalog = createAtlasRuntimeCatalog(root);
  const [old] = findEquipment(await catalog.read(), "weapon 旧", "gi");
  expect(old).toBeDefined();
  const child = Bun.spawn([process.execPath, cli, root, source, "gi/weapon=新"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe("");
  expect(exit).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ status: "published", version: 7, directory: join(root, "snapshots/7/data") });
  expect(await readlink(join(root, "current"))).toBe("snapshots/7/data");
  expect(await readFile(join(versionStore, "4/sentinel"), "utf8")).toBe("existing");
  expect(await readlink(join(versionStore, "6"))).toBe("missing");
  expect((await readdir(workspace)).sort()).toEqual(["atlas", "source"]);

  const current = await catalog.read();
  expect(findEquipment(current, "weapon 新", "gi")).toHaveLength(1);
  expect(findCharacters(current, "character 旧", "gi")).toHaveLength(1);
  expect((await catalog.equipmentFacts(old!)).scope).toBe("单手剑");
}));

test("同一预期的并发更新只发布一次，失败只清理自己准备的目录", () => fixture(async (workspace, root) => {
  const first = join(workspace, "first");
  const second = join(workspace, "second");
  await snapshot(root, "1", ["weapon", "character"]);
  await snapshot(first, "2");
  await snapshot(second, "3");
  const initial = await applyAtlasCandidate(root, first, weapon);
  expect(initial).toMatchObject({ status: "published", version: 1 });

  const results = await Promise.all([applyAtlasCandidate(root, first, weapon), applyAtlasCandidate(root, second, weapon)]);
  expect(results.map(({ status }) => status).sort()).toEqual(["published", "stale"]);
  expect(await readAtlasSnapshotVersion(root)).toBe(2);
  expect((await readdir(join(root, "snapshots"))).sort()).toEqual(["1", "2"]);

  const catalog = createAtlasRuntimeCatalog(root);
  expect(findCharacters(await catalog.read(), "character 1", "gi")).toHaveLength(1);
  await expect(applyAtlasCandidate(root, first, [{ game: "gi", pageId: "weapon", version: "invalid" }])).rejects.toThrow("未通过校验");
  await expect(applyAtlasCandidate(root, join(root, "snapshots/1"), weapon)).rejects.toThrow("独立目录");
  await expect(applyAtlasCandidate(root, "https://example.invalid/atlas", weapon)).rejects.toThrow("本地更新源");
  expect(await readAtlasSnapshotVersion(root)).toBe(2);
  expect((await readdir(workspace)).sort()).toEqual(["atlas", "first", "second"]);
}));

test("同轮不同分类累积到独立候选，活跃指针变化拒绝继续暂存", () => fixture(async (workspace, root) => {
  const source = join(workspace, "source");
  const roles = [{ game: "gi", pageId: "character" }] as const;
  await snapshot(root, "1", ["weapon", "character"]);
  await snapshot(source, "2", ["weapon", "character"]);
  const preparation: AtlasPreparation = {};
  const publication = { preparation };
  const candidate = join(root, ".prepared");
  expect(await applyAtlasCandidate(root, source, weapon, undefined, undefined, publication)).toMatchObject({ status: "prepared", version: 1 });
  expect(await applyAtlasCandidate(root, source, roles, undefined, preparation.baseline, publication)).toMatchObject({ status: "prepared", version: 2 });
  expect(await readAtlasSnapshotVersion(root)).toBeNull();
  expect(await readlink(join(candidate, "current"))).toBe("snapshots/2/data");
  expect(await readdir(join(candidate, "snapshots"))).toEqual(["2"]);
  const live = createAtlasRuntimeCatalog(root);
  const staged = createAtlasRuntimeCatalog(root, join(candidate, "current"));
  expect(findEquipment(await live.read(), "weapon 1", "gi")).toHaveLength(1);
  expect(findCharacters(await live.read(), "character 1", "gi")).toHaveLength(1);
  expect(findEquipment(await staged.read(), "weapon 2", "gi")).toHaveLength(1);
  expect(findCharacters(await staged.read(), "character 2", "gi")).toHaveLength(1);

  expect(await applyAtlasCandidate(root, source, weapon)).toMatchObject({ status: "published", version: 1 });
  expect(await applyAtlasCandidate(root, source, roles, undefined, preparation.baseline, publication))
    .toEqual({ status: "stale", current: 1 });
  expect(await readlink(join(candidate, "current"))).toBe("snapshots/2/data");
}));

test("关闭图库同步时保留旧字节和引用，发布新资料且没有新增图片的悬挂路径", () => fixture(async (workspace, root) => {
  const source = join(workspace, "source");
  await snapshot(root, "1");
  await snapshot(source, "2");
  async function attach(base: string, files: readonly (readonly [string, string])[]) {
    const file = join(base, "data/items/weapon.json");
    const previous = await Bun.file(file).json();
    await mkdir(join(base, "gallery/gi"), { recursive: true });
    const images = await Promise.all(files.map(async ([name, bytes]) => {
      const localPath = `gallery/gi/${name}.webp`;
      await writeFile(join(base, localPath), bytes);
      return { fieldPath: name, status: "downloaded", placeholder: false, localPath, bytes: bytes.length,
        remoteUrl: `https://static.nanoka.cc/assets/gi/${name}.webp`, sha256: createHash("sha256").update(bytes).digest("hex") };
    }));
    const text = JSON.stringify({ ...previous, meta: { ...previous.meta, images } });
    await writeFile(file, text.replace('"detail":null', '"detail":null,"uncut":90071992547409939'));
  }
  await attach(root, [["same", "old bytes"], ["previous", "untouched"]]);
  await attach(source, [["same", "changed image at same URL"], ["fresh", "brand new bytes"]]);
  const result = await applyAtlasCandidate(root, source, weapon, undefined, undefined, { retainGallery: true });
  expect(result).toMatchObject({ status: "published", version: 1 });
  const output = join(root, "snapshots/1");
  expect(await readFile(join(output, "gallery/gi/same.webp"), "utf8")).toBe("old bytes");
  expect(await readFile(join(output, "gallery/gi/previous.webp"), "utf8")).toBe("untouched");
  expect(await Bun.file(join(output, "gallery/gi/fresh.webp")).exists()).toBe(false);
  const item = join(output, "data/items/weapon.json");
  expect(await readFile(item, "utf8")).toContain('"uncut":90071992547409939');
  const { meta } = await Bun.file(item).json();
  expect(meta.version).toBe("2");
  expect(meta.images[1]).toMatchObject({ status: "not-synced", localPath: null, sha256: null });
  expect(galleryArtwork(meta.images, "gi")("same", "fresh")).toBe("gallery/gi/same.webp");
  expect(galleryArtwork(meta.images, "gi")("fresh")).toBeUndefined();

  expect(await applyAtlasCandidate(root, source, weapon, undefined, undefined, { retainGallery: true }))
    .toMatchObject({ status: "published", version: 2 });
  expect(await readFile(join(root, "snapshots/2/gallery/gi/previous.webp"), "utf8")).toBe("untouched");
  const refreshed = await applyAtlasCandidate(root, source, weapon);
  expect(refreshed).toMatchObject({ status: "published", version: 3 });
  expect(await readFile(join(root, "snapshots/3/gallery/gi/fresh.webp"), "utf8")).toBe("brand new bytes");

  const unsupported = await Bun.file(join(source, "data/items/weapon.json")).json();
  delete unsupported.meta.images[1].sha256;
  await Bun.write(join(source, "data/items/weapon.json"), JSON.stringify(unsupported));
  await expect(applyAtlasCandidate(root, source, weapon, undefined, undefined, { retainGallery: true }))
    .rejects.toThrow("源图片路径或哈希无效");
  expect(await readAtlasSnapshotVersion(root)).toBe(3);
}));
