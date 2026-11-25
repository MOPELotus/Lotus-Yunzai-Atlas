import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { atlasLocales } from "./locale.ts";
import { gameNames, type createAtlasCatalog } from "./catalog.ts";
import { renderAtlasStatus } from "./help.ts";
import { LegacyAtlasSourceConflict } from "./legacy-atlas-directory.ts";
import { AtlasSnapshotReset } from "./snapshot-pointer.ts";
import type { AtlasDelivery } from "./traditional.ts";

export const atlasDataUnavailable = $t("status.text_d74691f60e");

export async function atlasStatus(catalog: Pick<ReturnType<typeof createAtlasCatalog>, "read" | "statusSource" | "locale">, delivery?: AtlasDelivery) {
  let failure: string | undefined;
  const result = await catalog.read().catch(error => {
    failure = error instanceof LegacyAtlasSourceConflict || error instanceof AtlasSnapshotReset ? error.message : atlasDataUnavailable;
    return undefined;
  });
  const { root, galleryReady } = await catalog.statusSource();
  const pages = result?.pages ?? [];
  const rows = [
    $t("status.text_a4a7fca516", { "value1": result ? $t("status.text_cd396e8772", { "value1": pages.reduce((total, page) => total + page.entries.length, 0) }) : $t("status.text_65364e6fd8") }),
    $t("status.text_be35d8a00a", { "value1": result ? $t("status.text_de69d15875", { "length": pages.length }) : $t("status.text_65364e6fd8") }),
    $t("status.text_b5a8cc43e6", { "value1": galleryReady ? $t("status.text_de03ee139f") : $t("status.text_65364e6fd8") }),
    $t("status.text_65687894af", { "folder": atlasLocales[catalog.locale].folder }),
  ];
  for (const { game, name, version, entries, sampled, achievementCategories } of pages) {
    const count = achievementCategories
      ? $t("status.text_8075f0e20a", { "length": achievementCategories.length, "value2": achievementCategories.reduce((total, category) => total + category.entries.length, 0) })
      : $t("status.text_a6c377fdf3", { "length": entries.length });
    rows.push(`${gameNames[game]} · ${name} · ${version} · ${count}${sampled ? $t("status.text_eefb1e3dfa") : ""}`);
  }
  if (result?.stale) rows.push($t("status.text_764eee8500"));
  if (result?.rebuilt) rows.push($t("status.text_09ce400492"));
  if (failure) rows.push(failure);
  const lead = $t("status.text_e9f5e3f1fa", { "value1": result ? "READY" : "MISSING", "root": root });
  return renderAtlasStatus($t("status.text_9a7e760342"), lead, rows, delivery?.inlineImageByteLimit);
}
