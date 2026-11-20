import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareAtlasTheme } from "./prepare-theme.ts";

test("无原主题时可稍后重试，已有主题文件和自定义主题目录保持原样", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-theme-"));
  try {
    const checkout = pathToFileURL(root + sep);
    const persisted = join(root, "data/atlas/theme");
    const override = join(root, "custom");
    const donor = join(root, "plugins/Lotus-ReFactor/resources/miao-theme");
    const initial = await prepareAtlasTheme(checkout);
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
