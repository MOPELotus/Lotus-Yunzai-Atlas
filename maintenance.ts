import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { defaultAtlasLocale, parseAtlasLocale } from "./locale.ts";
import { atlasRootIsEmpty, discoverRuntimeAtlasDataDirectory, findLegacyAtlasExport, LegacyAtlasSourceConflict } from "./legacy-atlas-directory.ts";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atlasSourcePlan, atlasSourceSelections, refreshAtlasSource, type AtlasRefreshOptions,
  type AtlasSourceRefresh, type SourceSelection } from "./refresh-source.ts";
import { AtlasSnapshotReset, discoverAtlasDataDirectory } from "./snapshot-pointer.ts";
import { hasLegacyAtlasData, readAtlasSnapshotVersion, resetAtlasSnapshot, type AtlasPublicationOptions, type AtlasPublication } from "./publish-candidate.ts";
import { initializeAtlas, initializeAtlasFromPublic } from "./initialize-atlas.ts";
import { atlasManifestVersion, fetchAtlasManifest, type AtlasVersionChannel } from "./update-plan.ts";
import { validateAtlasCandidate, type AtlasCandidatePage } from "./validate-candidate.ts";
import { object } from "./source-values.ts";
import { atlasAllowsMissingDataInitialization, atlasUpdatePublicationOptions, atlasGenshinCardSelection, parseAtlasUpdatePolicy, type AtlasScheduleKind } from "./update-policy.ts";
import { legacyAtlasSourcePages } from "./legacy-source-profile.ts";
import { applyAtlasCandidate } from "./apply-candidate.ts";
import type { downloadAtlasVersion as DownloadAtlasVersion } from "./download-legacy-atlas.ts";
import { renderAtlasStatus } from "./help.ts";
import type { AtlasImage } from "./traditional.ts";

const checkCommand = "#检查图鉴更新";
const updateCommand = "#更新图鉴";
const resetCommand = "#重置图鉴";
const fullCommand = "#全量更新图鉴";
const names = [
  [checkCommand, $t("maintenance.text_18407f2acc"), $t("maintenance.text_0081035a40")],
  [updateCommand, $t("maintenance.text_f3da2d9ad9"), $t("maintenance.text_8739b76ffa")],
  [resetCommand, $t("maintenance.text_ac0f10a2bb"), $t("maintenance.text_b4c318a2ff"), $t("maintenance.text_7a91c98cee")],
  [fullCommand, $t("maintenance.text_ad4064c097"), $t("maintenance.text_a129de6bae")],
] as const;

export const atlasMaintenanceAliases = Object.fromEntries(names.flatMap(([target, ...words]) =>
  ["", "#"].flatMap((hash) => words.flatMap((word) => {
    const alias = `${hash}${word}`;
    return alias === target ? [] : [[alias, target]];
  }))));

const reviewReasons = {
  "local-unverified": $t("maintenance.text_79c12b1c4f"),
  "manifest-unavailable": $t("maintenance.text_bca4ca195f"),
  "unproven-upgrade": $t("maintenance.text_8721c2ee4a"),
} as const;

function describeRefresh(result: AtlasSourceRefresh, targetVersion: string): string {
  switch (result.status) {
    case "published": return $t("maintenance.text_7327f89ea6", { "targetVersion": targetVersion });
    case "prepared": return $t("maintenance.text_8bba9f4859", { "version": result.version });
    case "current": return $t("maintenance.text_cd1e045cad", { "version": result.version });
    case "review": return reviewReasons[result.reason];
    case "stale": return $t("maintenance.text_76ec12c518");
    case "busy": return $t("maintenance.text_6c5f47554f");
    case "invalid": return $t("maintenance.text_856bc930b5");
  }
}

export interface AtlasMaintenanceOptions extends Pick<AtlasRefreshOptions, "manifest" | "request" | "signal"> {
  readonly dataOverride?: string;
  readonly updateConfig?: unknown;
  readonly downloadVersion?: typeof DownloadAtlasVersion;
}

interface AtlasMaintenanceContext {
  readonly atlasMaintenance?: true;
  readonly isDelegated?: boolean;
  readonly inlineImageByteLimit?: number;
  readonly reply?: (message: string | AtlasImage) => boolean | Promise<boolean>;
}

export function createAtlasMaintenance(root: string, options: AtlasMaintenanceOptions = {}) {
  const { signal, request, dataOverride, manifest = fetchAtlasManifest } = options;
  const policy = parseAtlasUpdatePolicy(options.updateConfig);
  const configured = object(options.updateConfig);
  const configuredChannel = configured.version_channel;
  const locale = parseAtlasLocale(configured.locale) ?? defaultAtlasLocale;
  const syncAfterUpdate = configured.sync_after_update !== false;
  const syncGallery = configured.sync_gallery !== false;
  const includeArtwork = syncGallery || !syncAfterUpdate;
  const channel = configuredChannel === undefined ? "latest" : configuredChannel;
  const workspace = join(dirname(root), "atlas-download");
  let updating = false;

  function publicationOptions(): AtlasPublicationOptions {
    return atlasUpdatePublicationOptions(configured);
  }

  function acceptedBaseline(result: AtlasPublication, publication?: AtlasPublicationOptions) {
    if (result.status === "published") return { version: result.version, root: result.directory };
    if (result.status === "prepared") return publication?.preparation?.baseline;
  }

  async function run(kind: "check" | "update", selections: readonly string[], trigger?: AtlasScheduleKind | "manual-update",
    onStart?: () => Promise<void>) {
    if (signal?.aborted) return $t("maintenance.text_cfe6010915");
    if (!selections.length) return $t("maintenance.text_76cfbd225f");
    if (channel !== "live" && channel !== "latest") return $t("maintenance.text_36498405d4");
    if (kind === "update" && dataOverride) return $t("maintenance.text_6412aa91ff");
    if (locale === "cht") return $t("maintenance.text_b64465cf72");
    if (updating) return $t("maintenance.text_55863134b4");
    if (kind === "update") updating = true;
    const publication = kind === "update" ? publicationOptions() : undefined;
    try {
      await onStart?.();
      let active = dataOverride ? undefined : await discoverAtlasDataDirectory(root).catch(() => undefined);
      let baseline = dataOverride ? await realpath(dataOverride).catch(() => undefined) : active?.root;
      if (!baseline) {
        if (!dataOverride) {
          const fallback = await discoverRuntimeAtlasDataDirectory(root, locale).catch((error: unknown) => {
            if (error instanceof LegacyAtlasSourceConflict || error instanceof AtlasSnapshotReset) throw error;
          });
          if (fallback?.legacy === true) return $t("maintenance.text_5295d8b192");
        }
        const initializeMissing = trigger === "version" ? policy.version.initializeMissing
          : trigger === "manual-update" && atlasAllowsMissingDataInitialization(options.updateConfig);
        if (initializeMissing && channel === configuredChannel && !dataOverride && await atlasRootIsEmpty(root)) {
          await mkdir(root, { recursive: true, mode: 0o700 });
          const result = await initializeAtlasFromPublic(root, workspace, signal, channel,
            { manifest, request, emptyOnly: true, downloadVersion: options.downloadVersion, publication, locale });
          const action = trigger === "version" ? $t("maintenance.text_5d199e4105") : $t("maintenance.text_65622e8ee9");
          if (result.status === "prepared") return $t("maintenance.text_716b6e5f0a", { "action": action, "version": result.version });
          return result.status === "published" ? $t("maintenance.text_db9bdc61d1", { "action": action, "version": result.version })
            : $t("maintenance.text_8ce8132099", { "action": action, "value2": describeRefresh(result, "") });
        }
        return $t("maintenance.text_fc7ce19535");
      }

      const local = await validateAtlasCandidate(baseline, [], signal);
      if (!local.ok) return $t("maintenance.text_fc7ce19535");
      const pagesForLocale = local.pages.filter(page => (page.locale ?? defaultAtlasLocale) === locale);
      const listing = await manifest(signal).catch(() => undefined);
      if (signal?.aborted) return $t("maintenance.text_cfe6010915");
      if (!listing) return $t("maintenance.text_5d74fe58b3");
      const lines = [kind === "check" ? $t("maintenance.text_a7a2a739e5") : $t("maintenance.text_39737080fa")];
      const wantsCards = selections.includes(atlasGenshinCardSelection);
      const cardsVersion = wantsCards ? atlasManifestVersion(listing, "gi", channel) : undefined;
      const currentCards = pagesForLocale.find(({ game, pageId }) => game === "gi" && pageId === "gcg")?.version;
      const changeCards = cardsVersion !== undefined && currentCards !== cardsVersion;
      if (wantsCards) {
        const status = !cardsVersion ? reviewReasons["manifest-unavailable"]
          : !changeCards ? $t("maintenance.text_a5dd9b6faa", { "cardsVersion": cardsVersion })
          : $t("maintenance.text_4ad318f411", { "value1": currentCards ?? $t("maintenance.text_d3c3ad57b0"), "cardsVersion": cardsVersion });
        lines.push($t("maintenance.text_761bd81ffb", { "status": status }));
      }
      const scope = legacyAtlasSourcePages.filter(({ game, pageId }) => selections.includes(`${game}/${pageId}`));
      if ((!scope.length && !changeCards) || signal?.aborted) return lines.join("\n");
      const native = atlasSourceSelections.filter(({ selection }) => selection !== atlasGenshinCardSelection && selections.includes(selection));
      const versions = Object.fromEntries([...new Set(scope.map(({ game }) => game))]
        .map((game) => [game, atlasManifestVersion(listing, game, channel)]));
      const missing = Object.entries(versions).filter(([, version]) => !version).map(([game]) => game);
      const allCurrent = scope.every(({ game, pageId }) =>
        versions[game] && pagesForLocale.some((page) => page.game === game && page.pageId === pageId && page.version === versions[game]));
      const targetNotes = Object.entries(versions).map(([game, version]) => `${game} ${version ?? $t("maintenance.text_dc73097905")}`).join("、");
      const channelLabel = channel === "live" ? $t("maintenance.text_93a48223a5") : $t("maintenance.text_00bb111576");
      if (scope.length) lines.push($t("maintenance.text_2f20706539", { "channelLabel": channelLabel, "targetNotes": targetNotes, "value3": scope.length + Number(wantsCards) }));

      const currentRoles = pagesForLocale.filter(({ game, pageId, version }) => pageId === "character" &&
        version === versions[game] && scope.some(page => page.game === game && page.pageId === pageId));
      if (trigger !== "challenge" && currentRoles.length && (!wantsCards || cardsVersion && !changeCards)) {
        const { completeAtlasRoleMaterials, pendingAtlasRoleMaterials } = await import("./role-material-source.ts");
        const pending = await pendingAtlasRoleMaterials(baseline, currentRoles, signal, includeArtwork);
        if (pending.length && kind === "check") {
          lines.push($t("maintenance.text_daed5cdbcc", { "length": pending.length, "value2": includeArtwork ? $t("maintenance.text_d5e6d60866") : "" }));
        } else if (pending.length) {
          const stage = await mkdtemp(join(dirname(root), ".atlas-material-update-"));
          try {
            const { copyAtlasSelectedPages } = await import("./assemble-candidate.ts");
            const prepared = await copyAtlasSelectedPages(dirname(baseline), join(stage, "source"), pending, signal);
            const updated = await completeAtlasRoleMaterials(prepared.directory, pending, signal, request, includeArtwork);
            let remaining = pending.length;
            let remainingInCandidate = false;
            if (updated.length) {
              const stillMissing = await pendingAtlasRoleMaterials(join(prepared.directory, "data"), pending, signal, includeArtwork);
              const result = await applyAtlasCandidate(root, prepared.directory, updated, signal, active, publication);
              lines.push(result.status === "published" ? $t("maintenance.text_9b3a6a2fe1", { "length": updated.length })
                : $t("maintenance.text_d3668a8bb1", { "value1": describeRefresh(result, "") }));
              const next = acceptedBaseline(result, publication);
              if (next) {
                active = next;
                baseline = next.root;
                remaining = stillMissing.length;
                remainingInCandidate = result.status === "prepared";
              } else if (result.status === "busy" || result.status === "stale") return lines.join("\n");
            }
            if (remaining) {
              const subject = remainingInCandidate ? $t("maintenance.text_def2a88624") : "";
              lines.push($t("maintenance.text_9ab75e22ac", { "subject": subject, "remaining": remaining, "value3": includeArtwork ? $t("maintenance.text_6d8e08e8bc") : "" }));
            }
          } catch (error) {
            signal?.throwIfAborted();
            console.warn("[atlas]", error instanceof Error ? error.message : $t("maintenance.text_9d1109443e"));
            lines.push($t("maintenance.text_a9f5927eb0"));
          } finally {
            await rm(stage, { recursive: true, force: true }).catch(() => undefined);
          }
        }
      }

      if (includeArtwork && allCurrent && trigger !== "challenge" && (!wantsCards || cardsVersion && !changeCards) &&
          versions.gi && scope.some(({ game, pageId }) => game === "gi" && pageId === "character")) {
        try {
          const { genshinOriginalPortraitStatus } = await import("./genshin-original-portraits.ts");
          const version = versions.gi;
          const { pending } = await genshinOriginalPortraitStatus(baseline, version, signal, locale);
          if (kind === "check" && pending.length) {
            lines.push($t("maintenance.text_b6544a8b27", { "length": pending.length }));
          } else if (pending.length) {
            const { changedAtlasSourceIndexes, downloadAtlasVersionFromIndexes, readSelectedExporterIndexes } =
              await import("./download-legacy-atlas.ts");
            const indexes = await readSelectedExporterIndexes({ gi: version }, signal, request, [{ game: "gi", pageId: "character" }], locale);
            if ((await changedAtlasSourceIndexes(baseline, indexes, signal)).length) {
              lines.push($t("maintenance.text_4cdf443413"));
              return lines.join("\n");
            }
            let recovered = 0;
            const repaired = await downloadAtlasVersionFromIndexes(workspace, root, indexes, async (source, pages) => {
              const { ready } = await genshinOriginalPortraitStatus(join(source, "data"), version, signal, locale);
              recovered = pending.filter((id) => ready.includes(id)).length;
              if (recovered) return applyAtlasCandidate(root, source, pages, signal, active, publication);
            }, signal, baseline, request);
            lines.push(repaired?.status === "published"
              ? $t("maintenance.text_56cd0a6b70", { "recovered": recovered, "version": repaired.version })
              : repaired?.status === "prepared" ? $t("maintenance.text_53ddba063e", { "recovered": recovered, "version": repaired.version })
                : $t("maintenance.text_19176efda0"));
            return lines.join("\n");
          }
        } catch {
          lines.push(signal?.aborted ? $t("maintenance.text_cfe6010915") : $t("maintenance.text_6d75c3fa59"));
          return lines.join("\n");
        }
      }

      if (locale !== defaultAtlasLocale || changeCards || (wantsCards && !cardsVersion) || trigger === "challenge" || channel === "latest" || native.length !== scope.length || scope.length === legacyAtlasSourcePages.length ||
          native.some(({ selection }) => {
            const entry = atlasSourcePlan(selection, listing, local, channel).entries[0];
            return entry?.action === "review" && entry.reason === "unproven-upgrade";
          })) {
        if (kind === "check") {
          for (const { game, pageId } of scope) {
            const current = pagesForLocale.find((page) => page.game === game && page.pageId === pageId)?.version;
            const title = native.find(({ selection }) => selection === `${game}/${pageId}`)?.title ?? `${game}/${pageId}`;
            const target = versions[game];
            const summary = !target ? $t("maintenance.text_2d0f7094c0") : current === target ? $t("maintenance.text_c665f73806", { "target": target })
              : $t("maintenance.text_787aeeb910", { "value1": current ?? $t("maintenance.text_d3c3ad57b0"), "target": target });
            lines.push(`${title} · ${summary}`);
          }
        } else if (missing.length || (wantsCards && !cardsVersion)) {
          lines.push($t("maintenance.text_1b7e026d87", { "value1": [...new Set([...missing, ...(wantsCards && !cardsVersion ? ["gi"] : [])])].join("、") }));
        } else if (allCurrent && !changeCards && trigger !== "challenge") {
          lines.push($t("maintenance.text_ec4d921bb2", { "length": scope.length }));
        } else {
          const updateCount = (allCurrent ? 0 : scope.length) + (changeCards ? 1 : 0);
          try {
            const observed = trigger === "challenge" ? await (await import("./challenge-refresh-plan.ts"))
              .planAtlasChallengeRefresh(baseline, pagesForLocale, scope, versions, signal, request, locale) : undefined;
            if (observed?.length === 0) {
              lines.push($t("maintenance.text_fe82dd5549"));
              return lines.join("\n");
            }
            const publishWithCards = async (source?: string, pages: readonly AtlasCandidatePage[] = []) => {
              const stage = await mkdtemp(join(dirname(root), ".atlas-version-cards-"));
              try {
                const { acquireAtlasSource } = await import("./source-acquisition.ts");
                const cards = await acquireAtlasSource(join(stage, "cards"), [
                  { game: "gi", pageId: "gcg", version: cardsVersion, ...(locale !== defaultAtlasLocale && { locale }) },
                ], signal, request);
                if (!source) return await applyAtlasCandidate(root, cards.directory, cards.pages, signal, active, publication);
                const { assembleAtlasCandidate } = await import("./assemble-candidate.ts");
                const combined = await assembleAtlasCandidate(source, cards.directory, join(stage, "combined"), cards.pages, signal);
                return await applyAtlasCandidate(root, combined.directory, [...pages, ...cards.pages], signal, active, publication);
              } finally {
                await rm(stage, { recursive: true, force: true }).catch(() => undefined);
              }
            };
            const publish = (source: string, pages: readonly AtlasCandidatePage[]) => changeCards
              ? publishWithCards(source, pages)
              : applyAtlasCandidate(root, source, pages, signal, active, publication);
            const { downloadAtlasVersion, downloadAtlasVersionFromIndexes } = await import("./download-legacy-atlas.ts");
            const result = observed ? await downloadAtlasVersionFromIndexes(workspace, root, observed, publish, signal, baseline, request)
              : allCurrent ? await publishWithCards()
              : await (options.downloadVersion ?? downloadAtlasVersion)(workspace, root, versions, publish, signal, request, scope, baseline, locale);
            const coverage = observed ? $t("maintenance.text_10023a4719", { "length": observed.length })
              : allCurrent ? $t("maintenance.text_8c8df27f6c") : $t("maintenance.text_78a03c1095", { "updateCount": updateCount });
            lines.push(result.status === "published" ? $t("maintenance.text_ea0cc6cf35", { "coverage": coverage, "version": result.version })
              : $t("maintenance.text_c11231482f", { "coverage": coverage, "value2": describeRefresh(result, "") }));
          } catch (error) {
            if (signal?.aborted) return $t("maintenance.text_cfe6010915");
            console.warn("[atlas]", error instanceof Error ? error.message : $t("maintenance.text_d789551441"));
            lines.push($t("maintenance.text_ba4f669a8a", { "updateCount": updateCount }));
          }
        }
        return lines.join("\n");
      }

      for (const { selection, title } of native) {
        if (signal?.aborted) { lines.push($t("maintenance.text_cfe6010915")); break; }
        const entry = atlasSourcePlan(selection, listing, local, channel).entries[0];
        if (!entry || entry.kind !== "versioned") continue;
        let summary: string;
        if (entry.action === "review") summary = reviewReasons[entry.reason];
        else if (entry.action === "current") summary = $t("maintenance.text_71f3bfeb96", { "targetVersion": entry.targetVersion });
        else if (kind === "check") summary = $t("maintenance.text_6381ac1279", { "localVersion": entry.localVersion, "targetVersion": entry.targetVersion });
        else {
          try {
            const result = await refreshAtlasSource(root, { selection, preserveRecords: true, expected: active, signal, request,
              channel, manifest: async () => listing, publication });
            summary = describeRefresh(result, entry.targetVersion);
            if (result.status === "published" || result.status === "prepared") active = acceptedBaseline(result, publication);
            if (result.status === "busy" || result.status === "stale") {
              lines.push(`${title} · ${summary}`, $t("maintenance.text_9924455013"));
              return lines.join("\n");
            }
          } catch {
            summary = signal?.aborted ? $t("maintenance.text_be036087b6") : $t("maintenance.text_66e09aa55a");
          }
        }
        lines.push(`${title} · ${summary}`);
      }
      return lines.join("\n");
    } catch (error) {
      if (error instanceof LegacyAtlasSourceConflict || error instanceof AtlasSnapshotReset) return error.message;
      return signal?.aborted ? $t("maintenance.text_cfe6010915") : $t("maintenance.text_f5446217a0");
    } finally {
      if (kind === "update") updating = false;
    }
  }

  async function command(kind: "check" | "update", argument: string, context: AtlasMaintenanceContext) {
    if (context.isDelegated || context.atlasMaintenance !== true) return $t("maintenance.text_0d36d4e059");
    if (argument) return $t("maintenance.text_92702fca10", { "value1": kind === "check" ? checkCommand : updateCommand });
    const title = kind === "check" ? $t("maintenance.text_a7a2a739e5") : $t("maintenance.text_39737080fa");
    let started = false;
    const result = await run(kind, policy.version.selections, kind === "update" ? "manual-update" : undefined,
      context.reply && (async () => {
        started = true;
        await feedback(context, kind === "check" ? $t("maintenance.text_d0c1a32df8") : syncAfterUpdate
          ? $t("maintenance.text_1ee847eab2") : $t("maintenance.text_c23c8528bc"));
      }));
    return started ? presentResult(context, title, result) : result;
  }

  async function feedback(context: AtlasMaintenanceContext, message: string | AtlasImage) {
    try { return await context.reply?.(message) === true; } catch { return false; }
  }

  async function presentResult(context: AtlasMaintenanceContext, title: string, result: string) {
    if (!context.reply || signal?.aborted) return result;
    const rows = result.split("\n");
    if (rows[0] === title) rows.shift();
    const [lead = $t("maintenance.text_e6341fdc17"), ...contents] = rows;
    const card = await renderAtlasStatus(title, lead, contents, context.inlineImageByteLimit);
    if (typeof card === "string" || signal?.aborted || !await feedback(context, card)) return result;
    return [];
  }

  async function reset(argument: string, context: AtlasMaintenanceContext) {
    if (context.isDelegated || context.atlasMaintenance !== true) return $t("maintenance.text_187c603311");
    if (argument) return $t("maintenance.text_7f5a5a0f48", { "resetCommand": resetCommand });
    if (dataOverride) return $t("maintenance.text_cc53bd6fe9");
    if (updating) return $t("maintenance.text_55863134b4");
    updating = true;
    let summary: string;
    try {
      const result = await resetAtlasSnapshot(root, signal);
      if (result.status === "busy") return $t("maintenance.text_5c3c9ca389");
      summary = result.status === "empty" ? $t("maintenance.text_6a5b70b02d")
        : $t("maintenance.text_9dea67f0e0");
    } catch {
      summary = signal?.aborted ? $t("maintenance.text_1892c2deac") : $t("maintenance.text_eeffca51b0");
    } finally {
      updating = false;
    }
    return presentResult(context, $t("maintenance.text_a1d9a1a253"), summary);
  }

  async function fullUpdate(argument: string, context: AtlasMaintenanceContext) {
    if (context.isDelegated || context.atlasMaintenance !== true) return $t("maintenance.text_0d36d4e059");
    if (argument) return $t("maintenance.text_a1fd01784c", { "fullCommand": fullCommand });
    if (dataOverride) return $t("maintenance.text_6412aa91ff");
    if (signal?.aborted) return $t("maintenance.text_cfe6010915");
    if (channel !== "live" && channel !== "latest") return $t("maintenance.text_36498405d4");
    if (updating) return $t("maintenance.text_55863134b4");
    updating = true;
    let result: string;
    try {
      if (context.reply) await feedback(context, $t("maintenance.text_379b18aabc"));
      result = await runFullUpdate(channel);
    } finally {
      updating = false;
    }
    return presentResult(context, $t("maintenance.text_02f4bcddda"), result);
  }

  async function runFullUpdate(channel: AtlasVersionChannel) {
    if (locale === "cht") return $t("maintenance.text_b64465cf72");
    let existing = false;
    const publication = publicationOptions();
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      existing = await readAtlasSnapshotVersion(root) !== null || await hasLegacyAtlasData(root);
      if (existing) {
        const { refreshFullAtlasFromPublic } = await import("./full-refresh.ts");
        const result = await refreshFullAtlasFromPublic(root, workspace, channel, manifest, request, signal, publication, locale);
        if (result.status === "current") return $t("maintenance.text_c5e07c6f80");
        if (result.status === "published") return $t("maintenance.text_ed2d308174", { "version": result.version });
        if (result.status === "review") {
          if (result.reason === "manifest") return $t("maintenance.text_677eadf5cc");
          if (result.reason === "older") return $t("maintenance.text_be27cdb354");
          return $t("maintenance.text_baafe46bb2");
        }
        if (result.status === "invalid") {
          console.warn("[atlas]", result.issues[0] ?? $t("maintenance.text_461b879530"));
          return $t("maintenance.text_00f3a0dd93");
        }
        return `${describeRefresh(result, "")}。`;
      }
      const donor = configuredChannel === undefined ? await findLegacyAtlasExport(root) : undefined;
      const result = donor ? await initializeAtlas(root, donor, signal, publication)
        : await initializeAtlasFromPublic(root, workspace, signal, channel, { manifest, request, publication, locale });
      if (result.status === "published" || result.status === "prepared") {
        const initial = result.status === "published" ? $t("maintenance.text_9bd3b76919", { "version": result.version })
          : $t("maintenance.text_c44c0384aa", { "version": result.version });
        if (!donor) return initial;
        const next = await refreshAtlasSource(root, { selection: atlasGenshinCardSelection, channel, signal, request, manifest,
          expected: acceptedBaseline(result, publication), publication }).catch(() => undefined);
        if (next?.status === "published") return $t("maintenance.text_85d5a6e6b5", { "initial": initial, "version": next.version });
        if (next?.status === "prepared") return $t("maintenance.text_31e8a4f658", { "initial": initial, "version": next.version });
        if (next?.status === "current") return initial;
        return $t("maintenance.text_db2e57513e", { "initial": initial, "updateCommand": updateCommand });
      }
      if (result.status === "stale") return $t("maintenance.text_a697ff9f5c");
      if (result.status === "busy") return $t("maintenance.text_5c3c9ca389");
      return $t("maintenance.text_cdbc37343c");
    } catch (error) {
      if (error instanceof LegacyAtlasSourceConflict) return error.message;
      if (signal?.aborted) return $t("maintenance.text_cfe6010915");
      if (existing) {
        console.warn("[atlas]", error instanceof Error ? error.message : $t("maintenance.text_838d247eea"));
        return $t("maintenance.text_7450e285ce");
      }
      return $t("maintenance.text_4ecaaefc5a");
    }
  }

  // Version and rotation schedules may share a slot; serialize them so neither loses the workspace lock.
  let scheduledQueue = Promise.resolve();
  function scheduled(kind: AtlasScheduleKind) {
    const { cron, issue, selections } = policy[kind];
    return { cron, issue, run: () => {
      const pending = scheduledQueue.then(() => cron ? run("update", selections, kind) : $t("maintenance.text_ece6aabfc6"));
      scheduledQueue = pending.then(() => undefined, () => undefined);
      return pending;
    } };
  }

  return {
    commands: {
      [checkCommand]: (argument: string, context: AtlasMaintenanceContext) => command("check", argument, context),
      [updateCommand]: (argument: string, context: AtlasMaintenanceContext) => command("update", argument, context),
      [resetCommand]: reset,
      [fullCommand]: fullUpdate,
    },
    atlasSchedule: { version: scheduled("version"), challenge: scheduled("challenge") },
  };
}
