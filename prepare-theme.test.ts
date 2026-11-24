import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { AtlasInitializationProgress } from "./initialization-progress.ts";
import { prepareAtlasTheme } from "./prepare-theme.ts";

test("无原主题时可稍后重试，已有主题文件和自定义主题目录保持原样", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-theme-"));
  try {
    const checkout = pathToFileURL(root + sep);
    const persisted = join(root, "data/atlas/theme");
    const override = join(root, "custom");
    const donor = join(root, "plugins/Lotus-ReFactor/resources/miao-theme");
    const progress: AtlasInitializationProgress[] = [];
    const initial = await prepareAtlasTheme(checkout, { async onProgress(event) {
      progress.push(event);
      throw new Error("observer unavailable");
    } });
    expect(progress).toHaveLength(23);
    expect(progress[0]).toMatchObject({ stage: "theme", completed: 0, total: 22 });
    expect(progress.map(event => event.completed)).toEqual(Array.from({ length: 23 }, (_, index) => index));
    expect(progress.at(-1)).toMatchObject({ completed: 22, total: 22, unit: "个" });
    expect(initial.copied).toEqual([]);
    expect(initial.missing).toHaveLength(12);
    await expect(lstat(persisted)).rejects.toMatchObject({ code: "ENOENT" });
    await Promise.all([mkdir(join(persisted, "bg"), { recursive: true }), mkdir(override), mkdir(donor, { recursive: true })]);
    await writeFile(join(persisted, "bg/bg-hydro.webp"), "operator's background");
    await symlink(join(root, "temporarily-offline-card.png"), join(persisted, "card-bg.png"));
    await writeFile(join(donor, "card-bg.png"), Buffer.alloc(2594));
    const prepared = await prepareAtlasTheme(checkout);
    expect(prepared.copied).toEqual([]);
    expect(prepared.missing).not.toContain("bg/bg-hydro.webp");
    expect((await prepareAtlasTheme(checkout, { override })).missing).toContain("bg/bg-hydro.webp");
    expect(await readFile(join(persisted, "bg/bg-hydro.webp"), "utf8")).toBe("operator's background");
    expect((await lstat(join(persisted, "card-bg.png"))).isSymbolicLink()).toBe(true);
    await rm(join(persisted, "card-bg.png"));
    const repeated = await prepareAtlasTheme(checkout);
    expect(repeated.copied).toEqual([]);
    expect(await Bun.file(join(persisted, "card-bg.png")).exists()).toBe(false);

    await rm(join(donor, "card-bg.png"));
    const nativeDonor = join(root, "miao-plugin/resources");
    await mkdir(join(nativeDonor, "common/cont"), { recursive: true });
    await writeFile(join(nativeDonor, "common/cont/card-bg.png"), Buffer.alloc(2594));
    const native = await prepareAtlasTheme(checkout, { source: nativeDonor });
    expect(native.copied).toEqual([]);
    expect(native.missing).toContain("card-bg.png");
    await expect(lstat(join(persisted, "card-bg.png"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("初始化自动下载固定背景纹理，校验后保存，拒绝坏内容并保留已有文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-theme-download-"));
  const checkout = pathToFileURL(root + sep);
  const bytes = await readFile(new URL("./test-fixtures/theme-card.png", import.meta.url));
  const requests: string[] = [];
  let valid = false;
  const download = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    return url.endsWith("card-bg.png") ? new Response(valid ? bytes : Buffer.alloc(bytes.length)) : new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  try {
    expect((await prepareAtlasTheme(checkout, { download })).missing).toContain("card-bg.png");
    expect(await Bun.file(join(root, "data/atlas/theme/card-bg.png")).exists()).toBe(false);
    valid = true;
    const ready = await prepareAtlasTheme(checkout, { download });
    expect(ready.copied).toContain("card-bg.png");
    expect(ready.missing).not.toContain("card-bg.png");
    expect(await readFile(join(root, "data/atlas/theme/card-bg.png"))).toEqual(bytes);
    expect(requests.some(url => url.includes("278a607f564dc9e468e178918268c65ab2bfb51a"))).toBe(true);
    requests.length = 0;
    await prepareAtlasTheme(checkout, { override: join(root, "custom"), download });
    expect(requests).toHaveLength(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
