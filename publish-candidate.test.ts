import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAtlasRuntimeCatalog, findEquipment } from "./catalog.ts";
import { atlasApplyStagingPrefix, publishAtlasCandidate, publishPreparedAtlasCandidate, readAtlasSnapshotVersion } from "./publish-candidate.ts";

const itemPath = "items/weapon.json";
const imagePath = "gallery/gi/weapon.webp";
const pages = (version: number) => [{ game: "gi", pageId: "weapon", recordCount: 1, version: String(version) }] as const;

async function snapshot(root: string, version: number, type = "WEAPON_SWORD_ONE_HAND") {
  const candidate = join(root, "snapshots", String(version));
  const data = join(candidate, "data");
  await mkdir(join(data, "items"), { recursive: true });
  const name = `样例剑 ${version}`;
  const page = { id: "weapon", version: String(version), recordCount: 1, totalRecordCount: 1, sampled: false,
    records: { "1": { id: "1", name, path: itemPath, hasDetail: false } } };
  await writeFile(join(data, "map.json"), JSON.stringify({ games: { gi: { locales: { zh: { pages: { weapon: page } } } } } }));
  const image = join(candidate, imagePath);
  await mkdir(dirname(image), { recursive: true });
  await writeFile(image, `image ${version}`);
  await writeFile(join(data, itemPath), JSON.stringify({
    meta: { gameId: "gi", pageId: "weapon", locale: "zh", recordId: "1", version: String(version), name, hasDetail: false,
      images: [{ localPath: imagePath, status: "downloaded", sha256: createHash("sha256").update(`image ${version}`).digest("hex") }] },
    content: { list: { type }, detail: null },
  }));
  return { data, image };
}

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-publish-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("原子发布新目录后，在途图鉴读取保留旧版条目和图库", () => fixture(async (root) => {
  const catalog = createAtlasRuntimeCatalog(root);
  await expect(catalog.read()).rejects.toThrow();
  const legacy = await snapshot(root, 10, "WEAPON_CLAYMORE");
  const legacyPath = join(root, "data");
  await rename(legacy.data, legacyPath);
  const first = await snapshot(root, 1);
  const second = await snapshot(root, 2, "WEAPON_BOW");
  const pointer = join(root, "current");
  const [original] = findEquipment(await catalog.read(), "样例剑 10", "gi");
  expect(original).toBeDefined();
  expect(await readAtlasSnapshotVersion(root)).toBeNull();
  expect(await publishAtlasCandidate(root, null, 1, pages(1))).toEqual({ status: "published", version: 1, directory: first.data });
  const [old] = findEquipment(await catalog.read(), "样例剑 1", "gi");
  expect(old).toBeDefined();
  expect(await publishAtlasCandidate(root, 1, 2, pages(2))).toEqual({ status: "published", version: 2, directory: second.data });
  expect(await readlink(pointer)).toBe("snapshots/2/data");
  expect(await readAtlasSnapshotVersion(root)).toBe(2);
  const [current] = findEquipment(await catalog.read(), "样例剑 2", "gi");
  expect(current).toBeDefined();
  expect((await catalog.equipmentFacts(old!)).scope).toBe("单手剑");
  expect((await catalog.equipmentFacts(current!)).scope).toBe("弓");
  expect((await catalog.equipmentFacts(original!)).scope).toBe("双手剑");
  expect(catalog.assetRoot(old!)).toBe(first.data);
  expect(catalog.assetRoot(current!)).toBe(second.data);
  expect(await Bun.file(first.image).text()).toBe("image 1");
  const explicit = createAtlasRuntimeCatalog(root, legacyPath);
  expect((await explicit.read()).pages.map(({ version }) => version)).toEqual(["10"]);
  await expect(createAtlasRuntimeCatalog(root, join(root, "missing")).read()).rejects.toThrow();
}));

test("无效发布指针保持最近可用快照，冷启动拒绝读取错误目标", () => fixture(async (root) => {
  const legacy = await snapshot(root, 10, "WEAPON_CLAYMORE");
  await rename(legacy.data, join(root, "data"));
  const first = await snapshot(root, 1);
  const second = await snapshot(root, 2, "WEAPON_BOW");
  expect((await publishAtlasCandidate(root, null, 2, pages(2))).status).toBe("published");
  const catalog = createAtlasRuntimeCatalog(root);
  const good = await catalog.read();
  const pointer = join(root, "current");
  const pending = join(root, "fixture-pointer");
  await mkdir(join(root, "snapshots/3"));
  await symlink(second.data, join(root, "snapshots/3/data"), "dir");
  const wrong = await snapshot(root, 4);
  await rm(join(wrong.data, "map.json"));
  await symlink(join(first.data, "map.json"), join(wrong.data, "map.json"));

  const point = async (target: string) => {
    await symlink(target, pending, "dir");
    await rename(pending, pointer);
    expect(await catalog.read()).toEqual({ pages: good.pages, stale: true });
  };
  for (const target of [first.data, "data", "snapshots/2/data\n", "snapshots/99/data", "snapshots/3/data", "snapshots/4/data"]) {
    await point(target);
    await expect(createAtlasRuntimeCatalog(root).read()).rejects.toThrow();
  }
  await point("snapshots/1/data");
  await rm(pointer);
  expect(await catalog.read()).toEqual({ pages: good.pages, stale: true });
  expect((await createAtlasRuntimeCatalog(root).read()).pages.map(({ version }) => version)).toEqual(["10"]);
  await symlink("snapshots/2/data", pointer, "dir");
  expect(await catalog.read()).toEqual(good);
}));

test("竞争发布只有一个成功，过期及较低版本保持获胜指针", () => fixture(async (root) => {
  await Promise.all([snapshot(root, 1), snapshot(root, 2), snapshot(root, 3)]);
  expect((await publishAtlasCandidate(root, null, 1, pages(1))).status).toBe("published");
  const results = await Promise.all([publishAtlasCandidate(root, 1, 2, pages(2)), publishAtlasCandidate(root, 1, 3, pages(3))]);
  const published = results.filter(({ status }) => status === "published");
  expect(published).toHaveLength(1);
  const winner = published[0];
  if (winner?.status !== "published") throw new Error("没有发布者取得指针。");
  const current = winner.version;
  expect(await readAtlasSnapshotVersion(root)).toBe(current);
  expect(results.filter(({ status }) => status === "stale")).toEqual([{ status: "stale", current }]);
  expect(await publishAtlasCandidate(root, current, 1, pages(1))).toEqual({ status: "stale", current });
  expect(await realpath(join(root, "current"))).toBe(join(root, `snapshots/${current}/data`));
}));

test("首版发布拒绝占用的旧 data，并且多个空目录初始化请求只切换一次", () => fixture(async (work) => {
  const root = join(work, "atlas");
  const firstStage = await mkdtemp(join(work, atlasApplyStagingPrefix));
  const secondStage = await mkdtemp(join(work, atlasApplyStagingPrefix));
  await mkdir(join(root, "theme"), { recursive: true });
  await writeFile(join(root, "theme/original"), "保留主题");
  for (const stage of [firstStage, secondStage]) {
    const { data } = await snapshot(stage, 1);
    await rename(dirname(data), join(stage, "candidate"));
    await rm(join(stage, "snapshots"), { recursive: true });
  }
  const initial = (stage: string) => publishPreparedAtlasCandidate(root, null, join(stage, "candidate"), pages(1), undefined, true);
  await symlink(join(work, "missing-legacy"), join(root, "data"));
  expect(await initial(firstStage)).toMatchObject({ status: "invalid", issues: [expect.stringContaining("已有旧版 data")] });
  expect(await readlink(join(root, "data"))).toBe(join(work, "missing-legacy"));
  expect(await readAtlasSnapshotVersion(root)).toBeNull();
  await rm(join(root, "data"));

  const results = await Promise.all([initial(firstStage), initial(secondStage)]);
  expect(results.filter(({ status }) => status === "published")).toHaveLength(1);
  expect(results.filter(({ status }) => status === "stale")).toEqual([{ status: "stale", current: 1 }]);
  expect(await readAtlasSnapshotVersion(root)).toBe(1);
  expect(await Bun.file(join(root, "theme/original")).text()).toBe("保留主题");
}));

test("分类、条目、图库或候选实体目录复验失败时保持旧指针", () => fixture(async (root) => {
  const first = await snapshot(root, 1);
  const second = await snapshot(root, 2);
  expect((await publishAtlasCandidate(root, null, 1, pages(1))).status).toBe("published");
  expect((await publishAtlasCandidate(root, 1, 2, pages(3))).status).toBe("invalid");
  expect((await publishAtlasCandidate(root, 1, 2, [])).status).toBe("invalid");
  await writeFile(second.image, "changes after assembly");
  const corrupt = await publishAtlasCandidate(root, 1, 2, pages(2));
  expect(corrupt).toMatchObject({ status: "invalid", issues: [expect.stringContaining("图库文件内容与记录不符")] });
  await rm(second.image);
  expect((await publishAtlasCandidate(root, 1, 2, pages(2))).status).toBe("invalid");
  await writeFile(join(second.data, itemPath), "{}");
  expect((await publishAtlasCandidate(root, 1, 2, pages(2))).status).toBe("invalid");
  await mkdir(join(root, "snapshots/3"));
  await symlink(second.data, join(root, "snapshots/3/data"), "dir");
  expect((await publishAtlasCandidate(root, 1, 3, pages(3))).status).toBe("invalid");
  expect(await realpath(join(root, "current"))).toBe(first.data);
}));

test("发布进程硬中断后系统释放写锁，后续发布可替换遗留的临时链接", () => fixture(async (root) => {
  await Promise.all([snapshot(root, 1), snapshot(root, 2)]);
  expect((await publishAtlasCandidate(root, null, 1, pages(1))).status).toBe("published");
  const sidecar = join(root, ".publication.sqlite");
  const child = Bun.spawn([process.execPath, "-e", `
    import { Database } from "bun:sqlite";
    import { symlink } from "node:fs/promises";
    const db = new Database(Bun.env.ATLAS_TEST_LOCK);
    db.exec("BEGIN IMMEDIATE");
    await symlink("snapshots/2/data", Bun.env.ATLAS_TEST_PENDING, "dir");
    console.log("locked");
    setInterval(() => {}, 1000);
  `], { env: { ATLAS_TEST_LOCK: sidecar, ATLAS_TEST_PENDING: join(root, ".current-next") }, stdout: "pipe", stderr: "inherit" });
  try {
    const reader = child.stdout.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("locked\n");
    } finally {
      reader.releaseLock();
    }
    const lock = await stat(sidecar);
    const abort = new AbortController();
    const waiting = publishAtlasCandidate(root, 1, 2, pages(2), abort.signal);
    abort.abort(new Error("发布已取消"));
    await expect(waiting).rejects.toThrow("发布已取消");
    expect(await readAtlasSnapshotVersion(root)).toBe(1);
    child.kill("SIGKILL");
    await child.exited;
    expect((await publishAtlasCandidate(root, 1, 2, pages(2))).status).toBe("published");
    expect((await stat(sidecar)).ino).toBe(lock.ino);
    await expect(readlink(join(root, ".current-next"))).rejects.toThrow();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await child.exited;
  }
}));
