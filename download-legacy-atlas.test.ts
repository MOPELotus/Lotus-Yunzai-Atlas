import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { completedExporterPages, downloadLegacyAtlas } from "./download-legacy-atlas.ts";

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

test("下载只复用固定版本完整分类，待重试图片和抽样分类保留获取", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-download-resume-"));
  try {
    const directory = join(root, "data");
    await mkdir(directory);
    const page = (recordCount: number, version: string, sampled = false) => ({
      version, sampled, recordCount, totalRecordCount: recordCount,
      records: Object.fromEntries(Array.from({ length: recordCount }, (_, n) => [String(n), {}])),
    });
    const game = (pages: object) => ({ locales: { zh: { pages } } });
    await writeFile(join(directory, "map.json"), JSON.stringify({ games: {
      gi: game({ weapon: page(292, "7.2.52"), character: page(154, "7.2.52", true), artifact: page(67, "7.2") }),
      hsr: game({ lightcone: page(174, "4.7.52") }),
      zzz: game({ bangboo: page(43, "3.4.4+20539349") }),
    } }));
    await writeFile(join(directory, "gallery-index.json"), JSON.stringify({ images: [
      { gameId: "gi", pageId: "weapon", status: "placeholder", retryOnNextRun: true,
        retryable: false, placeholderReason: "remote_missing" },
      { gameId: "hsr", pageId: "lightcone", status: "error", retryOnNextRun: true },
    ] }));
    expect([...await completedExporterPages(root)]).toEqual(["gi/weapon"]);
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
