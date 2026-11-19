import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtlasRuntimeCatalog, findBangboos, findEquipment } from "./catalog.ts";
import { publishAtlasCandidate } from "./publish-candidate.ts";
import { acquireAtlasSource } from "./source-acquisition.ts";

const version = "3.4.4+20539349";
const scope = [{ game: "zzz", pageId: "bangboo", version, recordCount: 3 }] as const;
const listUrl = `https://static.nanoka.cc/zzz/${version}/bangboo.json`;
const makeDetailUrl = (id: number) => `https://static.nanoka.cc/zzz/${version}/zh/bangboo/${id}.json`;
const icon = "UI/Sprite/A1DynamicLoad/BangbooModGarage/UnPacker/BangbooRole/Fixture123.png";
const iconUrl = "https://static.nanoka.cc/assets/zzz/Fixture123.webp";
const fullIconUrl = `https://static.nanoka.cc/assets/zzz/${icon.slice(0, -4)}.webp`;
const imagePath = "gallery/zzz/Fixture123.webp";
const placeholderPath = "gallery/_placeholder/unknown.svg";
const legacyPlaceholderHash = "25fe1ba8bf237af8dc0157859efb518fa04c23b8e55ca4c05ec8292eebc2122e";
const webp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
const index = {
  "53001": { zh: "样例邦布甲", rank: 3, icon },
  "53002": { zh: "样例邦布乙", rank: 4, icon },
  "53003": { zh: "样例邦布丙", rank: 3, icon: "" },
};

function detail(id: 53001 | 53002) {
  const list = index[id];
  return { id, name: list.zh, rarity: list.rank, icon };
}

function source(url: string): Response {
  if (url === listUrl) return Response.json(index);
  if (url === makeDetailUrl(53001)) return Response.json(detail(53001));
  if (url === makeDetailUrl(53002)) return Response.json(detail(53002));
  if (url === makeDetailUrl(53003)) return new Response(null, { status: 404 });
  if (url === iconUrl) return new Response(new Uint8Array(webp), { headers: { "Content-Type": "image/webp" } });
  throw new Error(`unexpected URL ${url}`);
}

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-acquire-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("绝区零邦布抓取固定版本、复用同图并输出可验证和发布的完整分类", () => fixture(async (root) => {
  const snapshots = join(root, "snapshots");
  await mkdir(snapshots);
  const candidate = join(snapshots, "1");
  const requests: string[] = [];
  const acquired = await acquireAtlasSource(candidate, scope, undefined, async (url, options) => {
    requests.push(url);
    expect(options).toMatchObject({ redirect: "error", credentials: "omit" });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    return source(url);
  });
  expect(requests).toEqual([listUrl, makeDetailUrl(53001), iconUrl, makeDetailUrl(53002), makeDetailUrl(53003)]);
  expect(acquired).toEqual({ directory: candidate, pages: scope, imageCount: 1, missingImageCount: 0 });
  expect(await readFile(join(candidate, imagePath))).toEqual(webp);
  const data = join(candidate, "data");
  const map = await Bun.file(join(data, "map.json")).json();
  const page = map.games.zzz.locales.zh.pages.bangboo;
  expect(page).toMatchObject({ sampled: false, recordCount: 3, totalRecordCount: 3, sourceUrl: listUrl });
  const image = { status: "downloaded", placeholder: false, localPath: imagePath,
    remoteUrl: iconUrl, sha256: createHash("sha256").update(webp).digest("hex"), originalValue: icon };
  const withDetail = await Bun.file(join(data, page.records[53001].path)).json();
  expect(withDetail).toMatchObject({ meta: { hasDetail: true, images: [
    { ...image, fieldPath: "icon" }, { ...image, fieldPath: "detail.icon" },
  ] }, content: { detail: detail(53001) } });
  const withoutDetail = await Bun.file(join(data, page.records[53003].path)).json();
  expect(withoutDetail).toMatchObject({ meta: { hasDetail: false, images: [] }, content: { detail: null } });
  expect(await publishAtlasCandidate(root, null, 1, scope)).toMatchObject({ status: "published", directory: data });
  const catalog = createAtlasRuntimeCatalog(root);
  const [found] = findBangboos(await catalog.read(), "样例邦布乙");
  expect(found).toMatchObject({ name: "样例邦布乙", version });
  expect(await catalog.bangbooRarity(found!)).toBe("S级");
}));

test("先检查扁平图标，再检查完整素材路径，双缺失仍输出完整分类", () => fixture(async (root) => {
  const fallback = join(root, "fallback");
  const absent = join(root, "absent");
  const requests: string[] = [];
  for (const [directory, available] of [[fallback, true], [absent, false]] as const) {
    const acquired = await acquireAtlasSource(directory, scope, undefined, async (url) => {
      requests.push(url);
      if (url === iconUrl) return new Response(null, { status: 404 });
      if (url === fullIconUrl) return available ? source(iconUrl) : new Response(null, { status: 404 });
      return source(url);
    });
    expect(acquired).toMatchObject({ imageCount: available ? 1 : 0, missingImageCount: available ? 0 : 1 });
    expect(await Bun.file(join(directory, imagePath)).exists()).toBe(available);
    const item = await Bun.file(join(directory, "data/items/zh/zzz/bangboo/53001.json")).json();
    const placeholder = { status: "placeholder", placeholder: true, placeholderReason: "remote_missing",
      localPath: placeholderPath, sha256: legacyPlaceholderHash };
    expect(item.meta.images).toMatchObject(available ? [
      { fieldPath: "icon", status: "downloaded", remoteUrl: fullIconUrl, localPath: imagePath },
      { fieldPath: "detail.icon", status: "downloaded", remoteUrl: fullIconUrl, localPath: imagePath },
    ] : [
      { fieldPath: "icon", ...placeholder }, { fieldPath: "detail.icon", ...placeholder },
    ]);
  }
  expect(createHash("sha256").update(await readFile(join(absent, placeholderPath))).digest("hex")).toBe(legacyPlaceholderHash);
  expect(requests.filter((url) => url === iconUrl || url === fullIconUrl)).toEqual([iconUrl, fullIconUrl, iconUrl, fullIconUrl]);
  await mkdir(join(root, "snapshots"));
  await rename(absent, join(root, "snapshots", "1"));
  expect(await publishAtlasCandidate(root, null, 1, scope)).toMatchObject({ status: "published" });
}));

test("抓取拒绝无关范围，并在来源身份、图标或连接错误时清理候选", () => fixture(async (root) => {
  const candidate = join(root, "candidate");
  let count = 0;
  const request = async (url: string) => { count++; return source(url); };
  await expect(acquireAtlasSource(candidate, [{ game: "gi", pageId: "weapon", version }], undefined, request)).rejects.toThrow();
  await expect(acquireAtlasSource(candidate, [{ ...scope[0], version: "../../invalid" }], undefined, request)).rejects.toThrow();
  expect(count).toBe(0);
  await expect(acquireAtlasSource(candidate, scope, undefined, async (url) => url === makeDetailUrl(53002)
    ? Response.json({ ...detail(53002), id: 7 }) : source(url))).rejects.toThrow("身份或等级不符");
  expect(await Bun.file(join(candidate, imagePath)).exists()).toBe(false);
  await expect(acquireAtlasSource(candidate, scope, undefined, async (url) => url === iconUrl
    ? new Response("invalid image/webp") : source(url))).rejects.toThrow("WebP");
  await expect(acquireAtlasSource(candidate, scope, undefined, async (url) => url === iconUrl
    ? new Response(null, { status: 503 }) : source(url))).rejects.toThrow("HTTP 503");
  expect((await acquireAtlasSource(candidate, scope, undefined, request)).imageCount).toBe(1);
}));

const weaponScope = [{ game: "zzz", pageId: "weapon", version, recordCount: 3 }] as const;
const weaponListUrl = `https://static.nanoka.cc/zzz/${version}/weapon.json`;
const weaponDetail = (id: number) => `https://static.nanoka.cc/zzz/${version}/zh/weapon/${id}.json`;
const weaponIcon = (name: string) => `https://static.nanoka.cc/assets/zzz/${name}.webp`;
const weaponIconPrefix = "Assets/NapResources/UI/Sprite/A1DynamicLoad/ItemIconWeapon/UnPacker";
const weapons = [
  { id: 12001, zh: "音擎甲", icon: "Weapon_B_Fixture", rank: 2, type: 1 },
  { id: 13001, zh: "音擎乙", icon: "Weapon_A_Fixture", rank: 3, type: 4 },
  { id: 14001, zh: "音擎丙", icon: "Weapon_S_Fixture", rank: 4, type: 7 },
] as const;

function engineDetail({ id, zh, icon, rank, type }: typeof weapons[number]) {
  return { id, name: zh, code_name: icon, icon: `${weaponIconPrefix}/${icon}.png`, rarity: rank,
    weapon_type: { [type]: { name: "样例专精" } }, desc: "样例技能。", materials: "10:7200,101010:2",
    base_property: { name: "基础攻击力", value: 32 }, level: { 0: { rate: 0 } }, stars: { 0: { star_rate: 0 } },
    talents: { 1: { name: "样例效果", desc: "效果说明。" } } };
}

function weaponSource(url: string) {
  if (url === weaponListUrl) return Response.json(Object.fromEntries(weapons.map(({ id, ...row }) => [id, row])));
  for (const item of weapons) {
    if (url === weaponDetail(item.id)) return Response.json(engineDetail(item));
    if (url === weaponIcon(item.icon)) return new Response(new Uint8Array(webp));
  }
  throw new Error(`unexpected URL ${url}`);
}

test("抓取各等级音擎，发布后保留详情字段和两个图标引用", () => fixture(async (root) => {
  const candidate = join(root, "snapshots", "1");
  await mkdir(join(root, "snapshots"));
  const [first] = weapons;
  const requests: string[] = [];
  const result = await acquireAtlasSource(candidate, weaponScope, undefined, async (url) => {
    requests.push(url);
    if (url === weaponIcon(first.icon)) return new Response(null, { status: 404 });
    if (url === weaponIcon(`${weaponIconPrefix}/${first.icon}`)) return weaponSource(weaponIcon(first.icon));
    return weaponSource(url);
  });
  expect(result).toMatchObject({ pages: weaponScope, imageCount: 3, missingImageCount: 0 });
  expect(requests).toEqual([weaponListUrl, weaponDetail(first.id), weaponIcon(first.icon),
    weaponIcon(`${weaponIconPrefix}/${first.icon}`), ...weapons.slice(1).flatMap(({ id, icon }) => [weaponDetail(id), weaponIcon(icon)])]);
  expect(await publishAtlasCandidate(root, null, 1, weaponScope)).toMatchObject({ status: "published" });
  const catalog = createAtlasRuntimeCatalog(root);
  const index = await catalog.read();
  for (const [position, item] of weapons.entries()) {
    const { id, zh, icon } = item;
    const [entry] = findEquipment(index, zh, "zzz");
    expect(entry).toMatchObject({ id: String(id), name: zh, rarity: ["B级", "A级", "S级"][position] });
    const data = await Bun.file(join(candidate, "data", entry!.path)).json();
    const localPath = `gallery/zzz/${icon}.webp`;
    expect(data).toMatchObject({ meta: { images: [
      { fieldPath: "icon", originalValue: icon, status: "downloaded", localPath },
      { fieldPath: "detail.icon", originalValue: `${weaponIconPrefix}/${icon}.png`, status: "downloaded", localPath },
    ] }, content: { detail: engineDetail(item) } });
    expect(await catalog.weaponDetails(entry!)).toMatchObject({ artwork: localPath, description: "样例技能。",
      stats: [{ label: "Lv1基础攻击力", value: "32" }], refinements: [{ rank: 1, name: "样例效果", description: "效果说明。" }] });
  }
}));

test("音擎详情或图标不完整时清理候选，允许重新抓取", () => fixture(async (root) => {
  const candidate = join(root, "candidate");
  const [{ id, icon }] = weapons;
  const missing = () => new Response(null, { status: 404 });
  await expect(acquireAtlasSource(candidate, weaponScope, undefined, async (url) => url === weaponDetail(id)
    ? missing() : weaponSource(url))).rejects.toThrow("HTTP 404");
  await expect(acquireAtlasSource(candidate, weaponScope, undefined, async (url) => url === weaponDetail(id)
    ? Response.json({ ...engineDetail(weapons[0]), icon: `${weaponIconPrefix}/Weapon_wrong.png` })
    : weaponSource(url))).rejects.toThrow("身份或等级不符");
  await expect(acquireAtlasSource(candidate, weaponScope, undefined, async (url) => url === weaponIcon(icon) ||
    url === weaponIcon(`${weaponIconPrefix}/${icon}`) ? missing() : weaponSource(url))).rejects.toThrow("音擎来源图标缺失");
  expect((await acquireAtlasSource(candidate, weaponScope, undefined, async (url) => weaponSource(url))).imageCount).toBe(3);
}));

const lightconeVersion = "4.7.52";
const lightconeScope = [{ game: "hsr", pageId: "lightcone", version: lightconeVersion, recordCount: 2 }] as const;
const lightconeListUrl = `https://static.nanoka.cc/hsr/${lightconeVersion}/lightcone.json`;
const lightconeDetailUrl = (id: number) => `https://static.nanoka.cc/hsr/${lightconeVersion}/zh/lightcone/${id}.json`;
const lightconeAsset = (name: string) => `https://static.nanoka.cc/assets/hsr/${name}.webp`;
const cones = [
  { id: 20000, zh: "样例光锥甲", rank: "CombatPowerLightconeRarity3", baseType: "Rogue" },
  { id: 23000, zh: "样例光锥乙", rank: "CombatPowerLightconeRarity5", baseType: "Rogue" },
] as const;

function coneDetail({ id, zh, rank, baseType }: typeof cones[number]) {
  return {
    name: zh, rarity: rank, base_type: baseType,
    stats: Array.from({ length: 7 }, (_, index) => ({ equipment_id: id, max_level: (index + 2) * 10,
      base_hp: 20, base_hp_add: 1, base_attack: 10, base_attack_add: 1, base_defence: 5, base_defence_add: 1 })),
    refinements: { name: "效果夹具", desc: "增加#1[i]%攻击力。", level: Object.fromEntries(
      [1, 2, 3, 4, 5].map((rank) => [rank, { param_list: [rank / 10] }]),
    ) },
  };
}

function lightconeSource(url: string) {
  if (url === lightconeListUrl) return Response.json(Object.fromEntries(cones.map(({ id, ...row }) => [id, row])));
  if (url === lightconeAsset("pathicon/rogue")) return new Response(new Uint8Array(webp));
  for (const item of cones) {
    if (url === lightconeDetailUrl(item.id)) return Response.json(coneDetail(item));
    if (url === lightconeAsset(`lightconemediumicon/${item.id}`)) return new Response(new Uint8Array(webp));
  }
  throw new Error(`unexpected URL ${url}`);
}

test("光锥来源保留完整等级、叠影、原图和共享命途图标", () => fixture(async (root) => {
  const candidate = join(root, "snapshots", "1");
  await mkdir(join(root, "snapshots"));
  const calls: string[] = [];
  const result = await acquireAtlasSource(candidate, lightconeScope, undefined, async (url) => {
    calls.push(url);
    return lightconeSource(url);
  });
  expect(result).toMatchObject({ pages: lightconeScope, imageCount: 3, missingImageCount: 0 });
  expect(calls).toEqual([lightconeListUrl, lightconeDetailUrl(20000), lightconeAsset("lightconemediumicon/20000"),
    lightconeAsset("pathicon/rogue"), lightconeDetailUrl(23000), lightconeAsset("lightconemediumicon/23000")]);
  expect(await publishAtlasCandidate(root, null, 1, lightconeScope)).toMatchObject({ status: "published" });
  const catalog = createAtlasRuntimeCatalog(root);
  const index = await catalog.read();
  for (const [position, cone] of cones.entries()) {
    const [entry] = findEquipment(index, String(cone.id), "hsr");
    expect(entry).toMatchObject({ name: cone.zh, rarity: ["三星", "五星"][position] });
    const raw = await Bun.file(join(candidate, "data", entry!.path)).json();
    const artName = `lightconemediumicon/${cone.id}`;
    const asset = (fieldPath: string, value: string) => ({ fieldPath, originalValue: value, localPath: `gallery/hsr/${value}.webp`,
      status: "downloaded", sha256: createHash("sha256").update(webp).digest("hex") });
    expect(raw).toMatchObject({ meta: { images: [asset("derived.lightConeMediumIcon", artName),
      asset("derived.path", "pathicon/rogue"), asset("detail.derived.lightConeMediumIcon", artName)] },
      content: { detail: coneDetail(cone) } });
    const details = await catalog.weaponDetails(entry!);
    expect(details).toMatchObject({ artwork: `gallery/hsr/${artName}.webp`, refinements: [1, 2, 3, 4, 5].map((rank) => ({
      rank, name: "效果夹具", description: `增加${rank * 10}%攻击力。`,
    })), stats: [{ label: "Lv1生命", value: "20" }, { label: "Lv80生命", value: "99" },
      { label: "Lv1攻击", value: "10" }, { label: "Lv80攻击", value: "89" },
      { label: "Lv1防御", value: "5" }, { label: "Lv80防御", value: "84" }] });
  }
}));

test("光锥缺少详情、等级、叠影或任一真实图片时拒绝候选", () => fixture(async (root) => {
  const candidate = join(root, "candidate");
  const first = cones[0];
  const detail = coneDetail(first);
  const detailUrl = lightconeDetailUrl(first.id);
  const missing = () => new Response(null, { status: 404 });
  for (const [target, replacement, expected] of [
    [detailUrl, missing, "HTTP 404"],
    [detailUrl, () => Response.json({ ...detail, stats: detail.stats.slice(0, -1) }), "身份或等级不符"],
    [detailUrl, () => Response.json({ ...detail, refinements: { ...detail.refinements, level: {} } }), "身份或等级不符"],
    [lightconeAsset(`lightconemediumicon/${first.id}`), missing, "原图缺失"],
    [lightconeAsset("pathicon/rogue"), missing, "命途图标缺失"],
  ] as const) {
    await expect(acquireAtlasSource(candidate, lightconeScope, undefined, async (url) =>
      url === target ? replacement() : lightconeSource(url))).rejects.toThrow(expected);
  }
  expect((await acquireAtlasSource(candidate, lightconeScope, undefined, async (url) => lightconeSource(url))).imageCount).toBe(3);
}));
