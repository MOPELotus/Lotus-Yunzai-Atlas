import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCharacterGalleryPortrait } from "./role-render.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aKQgAAAAASUVORK5CYII=", "base64");

test("原画读取限定项目和角色，坏图、跨游戏和越界目录不参与选择", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-role-gallery-"));
  try {
    const gallery = join(root, "gallery");
    const zzz = join(gallery, "zzz-character");
    await mkdir(join(zzz, "雅"), { recursive: true });
    await mkdir(join(gallery, "gs-character"), { recursive: true });
    await writeFile(join(zzz, "雅", "坏图.png"), "invalid artwork");
    await writeFile(join(zzz, "雅", "原图.png"), png);
    await writeFile(join(gallery, "gs-character", "仅原神.png"), png);
    await symlink(join(zzz, "雅"), join(zzz, "链接角色"), "dir");
    await symlink(join(zzz, "雅", "原图.png"), join(zzz, "链接.png"));

    expect((await readCharacterGalleryPortrait("zzz", "雅", gallery))?.width).toBe(1);
    expect((await readCharacterGalleryPortrait("gi", "仅原神", gallery))?.height).toBe(1);
    expect(await readCharacterGalleryPortrait("zzz", "仅原神", gallery)).toBeUndefined();
    expect(await readCharacterGalleryPortrait("zzz", "链接角色", gallery)).toBeUndefined();
    expect(await readCharacterGalleryPortrait("zzz", "链接", gallery)).toBeUndefined();
    expect(await readCharacterGalleryPortrait("zzz", "../gs-character/仅原神", gallery)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
