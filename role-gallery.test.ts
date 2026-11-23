import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoleDetails } from "./role-data.ts";
import { readCharacterGalleryPortrait, readRolePhoto } from "./role-render.ts";

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
    await writeFile(join(zzz, "艾莲.png"), "invalid artwork");
    await mkdir(join(zzz, "艾莲·乔"));
    await writeFile(join(zzz, "艾莲·乔", "原图.png"), png);
    await writeFile(join(gallery, "gs-character", "仅原神.png"), png);
    await symlink(join(zzz, "雅"), join(zzz, "链接角色"), "dir");
    await symlink(join(zzz, "雅", "原图.png"), join(zzz, "链接.png"));

    expect((await readCharacterGalleryPortrait("zzz", "雅", gallery))?.width).toBe(1);
    expect(await readCharacterGalleryPortrait("zzz", "艾莲", gallery)).toBeUndefined();
    expect((await readCharacterGalleryPortrait("zzz", ["艾莲", "艾莲·乔"], gallery))?.width).toBe(1);
    expect(await readCharacterGalleryPortrait("gi", ["艾莲", "艾莲·乔"], gallery)).toBeUndefined();
    expect((await readCharacterGalleryPortrait("gi", "仅原神", gallery))?.height).toBe(1);
    expect(await readCharacterGalleryPortrait("zzz", "仅原神", gallery)).toBeUndefined();
    expect(await readCharacterGalleryPortrait("zzz", "链接角色", gallery)).toBeUndefined();
    expect(await readCharacterGalleryPortrait("zzz", "链接", gallery)).toBeUndefined();
    expect(await readCharacterGalleryPortrait("zzz", "../gs-character/仅原神", gallery)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("三游默认读各自的发布快照，拒绝越界指针并优先保留现有本地图", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-managed-gallery-"));
  const previous = Bun.env.LOTUS_CHARACTER_GALLERY_DIR;
  const large = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwH4QBEfcD/ePF9e8AAAAASUVORK5CYII=", "base64");
  const base = join(root, "data", "character-gallery-synced");
  const current = join(base, "current");
  const generation = "gallery-00000000-0000-4000-8000-000000000001";
  try {
    delete Bun.env.LOTUS_CHARACTER_GALLERY_DIR;
    const cases = [["gi", "gs-character", "图鉴托管原神甲"], ["hsr", "sr-character", "图鉴托管星铁甲"],
      ["zzz", "zzz-character", "图鉴托管绝区零甲"]] as const;
    for (const [, folder, name] of cases) {
      const synced = join(base, "snapshots", generation, folder);
      await mkdir(synced, { recursive: true });
      await writeFile(join(synced, `${name}.png`), png);
    }
    await symlink(`snapshots/${generation}`, current);
    for (const [game, , name] of cases) {
      expect((await readCharacterGalleryPortrait(game, name, undefined, root))?.width).toBe(1);
      expect(await readCharacterGalleryPortrait(game, name, join(root, "configured"), root)).toBeUndefined();
    }
    expect(await readCharacterGalleryPortrait("gi", cases[1][2], undefined, root)).toBeUndefined();
    const local = join(root, "data", "character-gallery", cases[0][1]);
    await mkdir(local, { recursive: true });
    await writeFile(join(local, `${cases[0][2]}.png`), large);
    expect((await readCharacterGalleryPortrait("gi", cases[0][2], undefined, root))?.width).toBe(2);
    await rm(current);
    await symlink(root, current);
    expect(await readCharacterGalleryPortrait("hsr", cases[1][2], undefined, root)).toBeUndefined();
  } finally {
    if (previous === undefined) delete Bun.env.LOTUS_CHARACTER_GALLERY_DIR;
    else Bun.env.LOTUS_CHARACTER_GALLERY_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("旧角色照片保留真实图片字节，不发送头像、错误来源或超限图片", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-role-photo-"));
  const previous = Bun.env.LOTUS_CHARACTER_GALLERY_DIR;
  const role: RoleDetails = {
    game: "hsr", id: "1005", version: "1", skills: [], ranks: [], materials: [],
    overview: { name: "照片测试角色", rarity: "五星", facts: [],
      artwork: "gallery/hsr/avatar.png", icon: "gallery/hsr/avatar.png", portraitFallbacks: ["gallery/hsr/artwork.png"] },
  };
  try {
    Bun.env.LOTUS_CHARACTER_GALLERY_DIR = join(root, "configured");
    await mkdir(join(root, "gallery", "hsr"), { recursive: true });
    await writeFile(join(root, "gallery", "hsr", "avatar.png"), png);
    const options = { galleryName: role.overview.name, assetRoot: root };
    expect(await readRolePhoto(role, options)).toBeUndefined();
    const artwork = join(root, "gallery", "hsr", "artwork.png");
    await writeFile(artwork, png);
    expect(await readRolePhoto(role, options)).toEqual(png);
    expect(await readRolePhoto(role, { ...options, inlineImageByteLimit: png.byteLength - 1 })).toBeUndefined();
    await rm(artwork);
    await writeFile(join(root, "outside.png"), png);
    await symlink(join(root, "outside.png"), artwork);
    expect(await readRolePhoto(role, options)).toBeUndefined();
    await rm(artwork);
    await writeFile(artwork, "invalid artwork");
    expect(await readRolePhoto(role, options)).toBeUndefined();
  } finally {
    if (previous === undefined) delete Bun.env.LOTUS_CHARACTER_GALLERY_DIR;
    else Bun.env.LOTUS_CHARACTER_GALLERY_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
