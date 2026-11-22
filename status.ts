import { gameNames, type createAtlasCatalog } from "./catalog.ts";
import { renderAtlasStatus } from "./help.ts";
import { LegacyAtlasSourceConflict } from "./legacy-atlas-directory.ts";
import { AtlasSnapshotReset } from "./snapshot-pointer.ts";
import type { AtlasDelivery } from "./traditional.ts";

export const atlasDataUnavailable = "图鉴数据不可用。请检查 data/atlas 快照或 LOTUS_ATLAS_DATA_DIR 设置。";

export async function atlasStatus(catalog: Pick<ReturnType<typeof createAtlasCatalog>, "read" | "statusSource">, delivery?: AtlasDelivery) {
  let failure: string | undefined;
  const result = await catalog.read().catch(error => {
    failure = error instanceof LegacyAtlasSourceConflict || error instanceof AtlasSnapshotReset ? error.message : atlasDataUnavailable;
    return undefined;
  });
  const { root, galleryReady } = await catalog.statusSource();
  const pages = result?.pages ?? [];
  const rows = [
    `条目：${result ? `${pages.reduce((total, page) => total + page.entries.length, 0)} 个` : "缺失"}`,
    `分类：${result ? `${pages.length} 个` : "缺失"}`,
    `图库：${galleryReady ? "已找到" : "缺失"}`,
    "语言：简体中文",
  ];
  for (const { game, name, version, entries, sampled, achievementCategories } of pages) {
    const count = achievementCategories
      ? `${achievementCategories.length} 类 · ${achievementCategories.reduce((total, category) => total + category.entries.length, 0)} 项`
      : `${entries.length} 个条目`;
    rows.push(`${gameNames[game]} · ${name} · ${version} · ${count}${sampled ? "（样例）" : ""}`);
  }
  if (result?.stale) rows.push("部分索引更新失败，已有数据的分类保留了上一次可用的版本。");
  if (failure) rows.push(failure);
  const lead = `${result ? "READY" : "MISSING"}\n数据目录：${root}`;
  return renderAtlasStatus("图鉴状态", lead, rows, delivery?.inlineImageByteLimit);
}
