import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadLegacyAtlas, inspectExporterPages } from "./download-legacy-atlas.ts";

test("公网初始化禁止工作区与发布目录重叠，已有发布时不启动下载", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-initialize-public-"));
  try {
    const target = join(root, "atlas");
    await mkdir(target);
    await expect(downloadLegacyAtlas(join(target, "work"), target, async () => 0)).rejects.toThrow("工作目录必须独立");
    await symlink("snapshots/3/data", join(target, "current"), "dir");
    const init = fileURLToPath(new URL("./initialize-atlas.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, init, target, "--public", join(root, "unused")], {
      stdout: "pipe", stderr: "pipe",
    });
    const stdout = new Response(child.stdout).json();
    expect(await child.exited).toBe(1);
    expect(await stdout).toEqual({ status: "stale", current: 3 });
    expect(await readlink(join(target, "current"))).toBe("snapshots/3/data");
    expect(await Bun.file(join(root, "unused", ".download.sqlite")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("公网下载只允许固定来源的匿名 GET 和 HEAD，禁止重定向", async () => {
  const policy = new URL("./public-atlas-network.mjs", import.meta.url).href;
  const source = `
    const calls = [];
    globalThis.fetch = (url, options) => {
      calls.push([options.method, options.credentials, options.redirect, [...options.headers.entries()]]);
      return Promise.resolve(new Response("public"));
    };
    await import(${JSON.stringify(policy)});
    await fetch(new Request("https://static.nanoka.cc/manifest.json", {headers: {
      Cookie: "test", Authorization: "test", Accept: "application/json",
    }}));
    await fetch("https://hsr.nanoka.cc/", {method:"HEAD", redirect:"follow", credentials:"include"});
    for(const [url, method] of [
      ["https://nte.nanoka.cc/", "GET"], ["https://other.example/", "GET"],
      ["http://gi.nanoka.cc/", "GET"], ["https://static.nanoka.cc/", "POST"],
      ["https://user@zzz.nanoka.cc/", "GET"],
    ]) {
      try { await fetch(url, {method}); throw Error("allowed"); }
      catch(error) { if (!error.message.includes("固定 Nanoka")) throw error; }
    }
    console.log(JSON.stringify(calls));`;
  const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(child.stdout).json();
  expect(await child.exited).toBe(0);
  expect(await stdout).toEqual([
    ["GET", "omit", "error", [["accept", "application/json"]]], ["HEAD", "omit", "error", []],
  ]);
});

test("续跑核对分类条目和原图，保留有效缓存及原站确认的占位", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-download-resume-"));
  try {
    const directory = join(root, "data");
    await mkdir(join(directory, "items"), { recursive: true });
    const page = async (gameId: string, pageId: string, version: string, recordCount: number, sampled = false) => {
      const entries = [];
      for (let index = 0; index < recordCount; index++) {
        const id = String(index);
        const name = `条目 ${index}`;
        const path = `items/${gameId}-${pageId.replaceAll("/", "-")}-${id}.json`;
        await writeFile(join(directory, path), JSON.stringify({
          meta: { gameId, pageId, version, recordId: id, name, locale: "zh", hasDetail: true },
          content: { list: {}, detail: {} },
        }));
        entries.push([id, { id, name, path, hasDetail: true }]);
      }
      return { id: pageId, version, sampled, recordCount, totalRecordCount: recordCount, records: Object.fromEntries(entries) };
    };
    const game = (pages: object) => ({ locales: { zh: { pages } } });
    const original = "webp";
    const sha256 = createHash("sha256").update(original).digest("hex");
    const files = ["gallery/gi/example.webp", "gallery/zzz/example.webp", "gallery/_placeholder/unknown.svg"];
    for (const path of ["gallery/gi", "gallery/zzz", "gallery/_placeholder"]) await mkdir(join(root, path), { recursive: true });
    for (const path of files) await writeFile(join(root, path), original);
    await writeFile(join(directory, "map.json"), JSON.stringify({ games: {
      gi: game({ leyline: await page("gi", "leyline", "7.2.52", 14),
        rolecombat: await page("gi", "rolecombat", "7.2.52", 31, true) }),
      hsr: game({ "achievement/achievement": await page("hsr", "achievement/achievement", "4.7.52", 9) }),
      zzz: game({ "achievement/achievement": await page("zzz", "achievement/achievement", "3.4.4+20539349", 3) }),
    } }));
    await writeFile(join(directory, "gallery-index.json"), JSON.stringify({ images: [
      { gameId: "gi", pageId: "leyline", status: "downloaded", localPath: files[0], sha256 },
      { gameId: "hsr", pageId: "achievement/achievement", status: "placeholder", placeholder: true,
        retryOnNextRun: true, retryable: false, placeholderReason: "remote_missing", localPath: files[2], sha256 },
      { gameId: "zzz", pageId: "achievement/achievement", status: "downloaded", localPath: files[1], sha256 },
    ] }));
    expect([...(await inspectExporterPages(root)).completed]).toEqual(["gi/leyline", "hsr/achievement/achievement", "zzz/achievement/achievement"]);
    await writeFile(join(root, files[0]!), "wEbp");
    await unlink(join(root, files[1]!));
    const damaged = await inspectExporterPages(root);
    expect([...damaged.completed]).toEqual(["hsr/achievement/achievement"]);
    expect([...damaged.corruptImages]).toEqual([join(root, files[0]!)]);
    await writeFile(join(root, files[0]!), original);
    await writeFile(join(root, files[1]!), original);
    await unlink(join(directory, "items", "gi-leyline-0.json"));
    await writeFile(join(directory, "items", "zzz-achievement-achievement-0.json"), "{invalid");
    expect([...(await inspectExporterPages(root)).completed]).toEqual(["hsr/achievement/achievement"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("续跑拒绝修改工作目录外的链接目标", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-download-links-"));
  try {
    const outside = join(root, "outside");
    const backend = join(root, "backend");
    const data = join(backend, "data");
    await mkdir(data, { recursive: true });
    await writeFile(outside, "keep");
    await symlink(outside, join(data, "map.json"));
    await expect(inspectExporterPages(backend)).rejects.toThrow("不能包含链接");
    await unlink(join(data, "map.json"));
    await link(outside, join(data, "gallery-index.json"));
    await expect(inspectExporterPages(backend)).rejects.toThrow("不能包含链接");
    expect(await Bun.file(outside).text()).toBe("keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("公网工作区的第二个获取者不会启动 Git 或覆盖已下载的数据", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-download-lock-"));
  const workspace = join(root, "work");
  const target = join(root, "atlas");
  await Promise.all([mkdir(workspace), mkdir(target)]);
  const active = new Database(join(workspace, ".download.sqlite"));
  try {
    active.exec("BEGIN IMMEDIATE");
    await expect(downloadLegacyAtlas(workspace, target, async () => 0)).rejects.toThrow("已有公网图鉴下载");
    expect(await Bun.file(join(workspace, "backend", ".git", "HEAD")).exists()).toBe(false);
  } finally {
    active.close();
    await rm(root, { recursive: true, force: true });
  }
});
