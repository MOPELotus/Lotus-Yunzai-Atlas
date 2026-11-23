import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyAtlasCandidate } from "./apply-candidate.ts";
import { createAtlasRuntimeCatalog, findEquipment } from "./catalog.ts";
import { downloadAtlasVersion } from "./download-legacy-atlas.ts";
import { createModule } from "./index.ts";
import { atlasLocales, type AtlasLocale } from "./locale.ts";
import type { AtlasSourceFetch } from "./source-transport.ts";
import { validateAtlasCandidate } from "./validate-candidate.ts";

const channel = "7.2.52";
const labels = { zh: "风鹰剑", en: "Aquila Favonia", ja: "風鷹剣", ko: "매의 검", cht: "風鷹劍" } as const;
const scope = [{ game: "gi", pageId: "weapon" }] as const;
const identity = { game: "gi", pageId: "weapon", version: channel, recordCount: 1 } as const;

async function fixture(root: string, locale: AtlasLocale, version = channel) {
  const folder = atlasLocales[locale].folder;
  const data = join(root, "data");
  const path = `items/${folder}/原神/武器/五星/${labels[locale]}.json`;
  const name = labels[locale];
  await mkdir(join(data, dirname(path)), { recursive: true });
  await Bun.write(join(data, path), JSON.stringify({ meta: {
    gameId: "gi", gameFolder: "原神", pageId: "weapon", pageFolder: "武器", locale, localeFolder: folder,
    recordId: "11501", name, rarity: "五星", version, hasDetail: false,
    sourcePath: `${version}/weapon.json`, sourceUrl: `https://static.nanoka.cc/gi/${version}/weapon.json`,
  }, content: { list: labels, detail: null } }));
  await Bun.write(join(data, "map.json"), JSON.stringify({ games: { gi: { locales: {
    [locale]: { locale: { folder }, pages: { weapon: { id: "weapon", version,
      recordCount: 1, totalRecordCount: 1, sampled: false, records: { "11501": { id: "11501", path, name, hasDetail: false } },
    } } },
  } } } }));
}

test("多语差分合并保留现用目录，邻近语种能独立匹配 ID 与名称，重复下载复用已验证详情", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-multilocale-"));
  try {
    const target = join(root, "atlas");
    const workspace = join(root, "downloads");
    await fixture(target, "zh");
    const requested: string[] = [];
    const request: AtlasSourceFetch = async (url) => {
      const path = new URL(url).pathname;
      requested.push(path);
      if (path === `/gi/${channel}/weapon.json`) return Response.json({ "11501": { ...labels, rank: 5 } });
      const locale = path.split("/")[3] as AtlasLocale;
      if (path === `/gi/${channel}/${locale}/weapon/11501.json`) return Response.json({ name: labels[locale] });
      throw new Error(path);
    };
    for (const locale of ["en", "ja", "ko"] as const) {
      const publish = downloadAtlasVersion(workspace, target, { gi: channel },
        (source, pages) => applyAtlasCandidate(target, source, pages), undefined, request, scope, undefined, locale);
      expect((await publish).status).toBe("published");
      const catalog = createAtlasRuntimeCatalog(target, undefined, locale);
      expect(findEquipment(await catalog.read(), labels[locale], "gi")[0]?.name).toBe(labels[locale]);
      const status = await catalog.statusSource();
      const before = requested.length;
      await downloadAtlasVersion(workspace, target, { gi: channel }, async (_, pages) => {
        expect(pages).toEqual([{ ...identity, locale }]);
      }, undefined, request, scope, status.root, locale);
      expect(requested.slice(before)).toEqual([`/gi/${channel}/weapon.json`]);
    }
    const status = await createAtlasRuntimeCatalog(target).statusSource();
    const candidate = await validateAtlasCandidate(status.root);
    expect(candidate.pages.map(({ locale }) => locale ?? "zh")).toEqual(["zh", "en", "ja", "ko"]);
    const previous = Bun.env.LOTUS_ATLAS_DATA_DIR;
    Bun.env.LOTUS_ATLAS_DATA_DIR = status.root;
    try {
      const english = createModule({ atlasUpdateConfig: { locale: "English" } });
      const chinese = createModule();
      expect(await english.commands["#武器图鉴"]("11501", { inlineImageByteLimit: 1 })).toContain(labels.en);
      expect(await chinese.commands["#武器图鉴"]("11501", { inlineImageByteLimit: 1 })).toContain(labels.zh);
      expect(await english.commands["#图鉴状态"]("", { inlineImageByteLimit: 1 })).toContain("语言：English");
    } finally {
      if (previous === undefined) delete Bun.env.LOTUS_ATLAS_DATA_DIR;
      else Bun.env.LOTUS_ATLAS_DATA_DIR = previous;
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("能读取旧繁體中文目录，缺索引时按旧目录重建，公网更新不覆盖本地来源", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-local-cht-"));
  try {
    await fixture(root, "cht");
    const data = join(root, "data");
    const index = join(data, "map.json");
    const catalog = createAtlasRuntimeCatalog(root, undefined, "cht");
    expect(findEquipment(await catalog.read(), labels.cht, "gi")[0]?.name).toBe(labels.cht);
    await rm(index);
    const recovered = await catalog.read();
    expect(recovered.rebuilt).toBeTrue();
    expect(findEquipment(recovered, labels.cht, "gi")[0]?.name).toBe(labels.cht);
    await expect(downloadAtlasVersion(join(root, "downloads"), data, { gi: channel }, async () => {},
      undefined, async () => { throw new Error("不应请求公开来源"); }, scope, undefined, "cht")).rejects.toThrow("不提供繁體中文");
  } finally { await rm(root, { recursive: true, force: true }); }
});
