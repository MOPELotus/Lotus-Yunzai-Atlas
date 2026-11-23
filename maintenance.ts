import { atlasRootIsEmpty, discoverRuntimeAtlasDataDirectory, findLegacyAtlasExport, LegacyAtlasSourceConflict } from "./legacy-atlas-directory.ts";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atlasSourcePlan, atlasSourceSelections, refreshAtlasSource, type AtlasRefreshOptions,
  type AtlasSourceRefresh, type SourceSelection } from "./refresh-source.ts";
import { AtlasSnapshotReset, discoverAtlasDataDirectory } from "./snapshot-pointer.ts";
import { hasLegacyAtlasData, readAtlasSnapshotVersion, resetAtlasSnapshot, type AtlasPreparation, type AtlasPublication } from "./publish-candidate.ts";
import { initializeAtlas, initializeAtlasFromPublic } from "./initialize-atlas.ts";
import { atlasManifestVersion, fetchAtlasManifest, type AtlasVersionChannel } from "./update-plan.ts";
import { validateAtlasCandidate, type AtlasCandidatePage } from "./validate-candidate.ts";
import { object } from "./source-values.ts";
import { atlasAllowsMissingDataInitialization, atlasGenshinCardSelection, parseAtlasUpdatePolicy, type AtlasScheduleKind } from "./update-policy.ts";
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
  [checkCommand, "检查图鉴更新", "图鉴检查更新"],
  [updateCommand, "更新图鉴", "图鉴更新"],
  [resetCommand, "重置图鉴", "图鉴重置", "清空图鉴"],
  [fullCommand, "全量更新图鉴", "图鉴全量更新"],
] as const;

export const atlasMaintenanceAliases = Object.fromEntries(names.flatMap(([target, ...words]) =>
  ["", "#"].flatMap((hash) => words.flatMap((word) => {
    const alias = `${hash}${word}`;
    return alias === target ? [] : [[alias, target]];
  }))));

const reviewReasons = {
  "local-unverified": "现有分类不完整，保留现有资料",
  "manifest-unavailable": "未能核实来源版本",
  "unproven-upgrade": "来源版本低于现有版本或无法比较，保留现有资料",
} as const;

function describeRefresh(result: AtlasSourceRefresh, targetVersion: string): string {
  switch (result.status) {
    case "published": return `已更新至 ${targetVersion}`;
    case "prepared": return `候选 ${result.version} 已校验并保存，现用图鉴保持原版`;
    case "current": return `已是同一正式版本 ${result.version}`;
    case "review": return reviewReasons[result.reason];
    case "stale": return "现用快照已切换，本次候选未发布";
    case "busy": return "已有发布正在进行，本次候选未发布";
    case "invalid": return "候选校验未通过，保留现有资料";
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
  const configuredChannel = object(options.updateConfig).version_channel;
  const syncAfterUpdate = object(options.updateConfig).sync_after_update !== false;
  const channel = configuredChannel === undefined ? "latest" : configuredChannel;
  const workspace = join(dirname(root), "atlas-download");
  let updating = false;

  function acceptedBaseline(result: AtlasPublication, preparation?: AtlasPreparation) {
    if (result.status === "published") return { version: result.version, root: result.directory };
    if (result.status === "prepared") return preparation?.baseline;
  }

  async function run(kind: "check" | "update", selections: readonly string[], trigger?: AtlasScheduleKind | "manual-update",
    onStart?: () => Promise<void>) {
    if (signal?.aborted) return "图鉴维护已中止。";
    if (!selections.length) return "图鉴配置未选中已核实的分类。";
    if (channel !== "live" && channel !== "latest") return "图鉴 version_channel 须为 live 或 latest，请先修正配置。";
    if (kind === "update" && dataOverride) return "当前使用显式图鉴数据目录，请通过本地运维更新该目录。";
    if (updating) return "已有图鉴更新正在进行，请稍后再试。";
    if (kind === "update") updating = true;
    const preparation: AtlasPreparation | undefined = kind === "update" && !syncAfterUpdate ? {} : undefined;
    try {
      await onStart?.();
      let active = dataOverride ? undefined : await discoverAtlasDataDirectory(root).catch(() => undefined);
      let baseline = dataOverride ? await realpath(dataOverride).catch(() => undefined) : active?.root;
      if (!baseline) {
        if (!dataOverride) {
          const fallback = await discoverRuntimeAtlasDataDirectory(root).catch((error: unknown) => {
            if (error instanceof LegacyAtlasSourceConflict || error instanceof AtlasSnapshotReset) throw error;
          });
          if (fallback?.legacy === true) return "当前图鉴只读使用旧版导出。请先运行本地初始化，再管理更新。";
        }
        const initializeMissing = trigger === "version" ? policy.version.initializeMissing
          : trigger === "manual-update" && atlasAllowsMissingDataInitialization(options.updateConfig);
        if (initializeMissing && channel === configuredChannel && !dataOverride && await atlasRootIsEmpty(root)) {
          await mkdir(root, { recursive: true, mode: 0o700 });
          const result = await initializeAtlasFromPublic(root, workspace, signal, channel,
            { manifest, request, emptyOnly: true, downloadVersion: options.downloadVersion, preparation });
          const action = trigger === "version" ? "自动初始化" : "初始化";
          if (result.status === "prepared") return `图鉴${action}候选已保存，尚未发布至现用目录。候选 ${result.version}。`;
          return result.status === "published" ? `图鉴${action}完成，已发布第 ${result.version} 版。`
            : `图鉴未${action}，${describeRefresh(result, "")}。`;
        }
        return "图鉴数据未初始化或无法验证，请先准备完整快照。";
      }

      let local = await validateAtlasCandidate(baseline, [], signal);
      if (!local.ok) return "图鉴数据未初始化或无法验证，请先准备完整快照。";
      const listing = await manifest(signal).catch(() => undefined);
      if (signal?.aborted) return "图鉴维护已中止。";
      if (!listing) return "图鉴版本清单不可用，保留现有资料。";
      const lines = [kind === "check" ? "图鉴版本检查" : "图鉴更新结果"];
      const wantsCards = selections.includes(atlasGenshinCardSelection);
      const cardsVersion = wantsCards ? atlasManifestVersion(listing, "gi", channel) : undefined;
      const currentCards = local.pages.find(({ game, pageId }) => game === "gi" && pageId === "gcg")?.version;
      const changeCards = cardsVersion !== undefined && currentCards !== cardsVersion;
      if (wantsCards) {
        const status = !cardsVersion ? reviewReasons["manifest-unavailable"]
          : !changeCards ? `已是同一版本 ${cardsVersion}`
          : `${currentCards ?? "未准备"} → ${cardsVersion}，待更新`;
        lines.push(`七圣召唤 · ${status}`);
      }
      const scope = legacyAtlasSourcePages.filter(({ game, pageId }) => selections.includes(`${game}/${pageId}`));
      if ((!scope.length && !changeCards) || signal?.aborted) return lines.join("\n");
      const native = atlasSourceSelections.filter(({ selection }) => selection !== atlasGenshinCardSelection && selections.includes(selection));
      const versions = Object.fromEntries([...new Set(scope.map(({ game }) => game))]
        .map((game) => [game, atlasManifestVersion(listing, game, channel)]));
      const missing = Object.entries(versions).filter(([, version]) => !version).map(([game]) => game);
      const allCurrent = scope.every(({ game, pageId }) =>
        versions[game] && local.pages.some((page) => page.game === game && page.pageId === pageId && page.version === versions[game]));
      const targetNotes = Object.entries(versions).map(([game, version]) => `${game} ${version ?? "版本未知"}`).join("、");
      const channelLabel = channel === "live" ? "正式版" : "网站最新版";
      if (scope.length) lines.push(`${channelLabel} · ${targetNotes} · 本次范围 ${scope.length + Number(wantsCards)} 类`);

      const currentRoles = local.pages.filter(({ game, pageId, version }) => pageId === "character" &&
        version === versions[game] && scope.some(page => page.game === game && page.pageId === pageId));
      if (trigger !== "challenge" && currentRoles.length && (!wantsCards || cardsVersion && !changeCards)) {
        const { completeAtlasRoleMaterials, pendingAtlasRoleMaterials } = await import("./role-material-source.ts");
        const pending = await pendingAtlasRoleMaterials(baseline, currentRoles, signal);
        if (pending.length && kind === "check") {
          lines.push(`${pending.length} 个角色分类待补齐同版材料名称与图标。`);
        } else if (pending.length) {
          const stage = await mkdtemp(join(dirname(root), ".atlas-material-update-"));
          try {
            const { copyAtlasSelectedPages } = await import("./assemble-candidate.ts");
            const prepared = await copyAtlasSelectedPages(dirname(baseline), join(stage, "source"), pending, signal);
            const updated = await completeAtlasRoleMaterials(prepared.directory, pending, signal, request);
            if (pending.length > updated.length) {
              lines.push(`${pending.length - updated.length} 个角色分类仍缺同版材料名称或原图。`);
            }
            if (updated.length) {
              const result = await applyAtlasCandidate(root, prepared.directory, updated, signal, active, preparation);
              lines.push(result.status === "published" ? `${updated.length} 个角色分类已补齐同版材料名称与可用原图。`
                : `同版角色材料：${describeRefresh(result, "")}。`);
              const next = acceptedBaseline(result, preparation);
              if (next) {
                active = next;
                baseline = next.root;
              } else if (result.status === "busy" || result.status === "stale") return lines.join("\n");
            }
          } catch (error) {
            signal?.throwIfAborted();
            console.warn("[atlas]", error instanceof Error ? error.message : "图鉴材料补齐失败。");
            lines.push("同版角色材料未补齐，保留现用资料。");
          } finally {
            await rm(stage, { recursive: true, force: true }).catch(() => undefined);
          }
        }
      }

      if (allCurrent && trigger !== "challenge" && (!wantsCards || cardsVersion && !changeCards) &&
          versions.gi && scope.some(({ game, pageId }) => game === "gi" && pageId === "character")) {
        try {
          const { genshinOriginalPortraitStatus } = await import("./genshin-original-portraits.ts");
          const version = versions.gi;
          const { pending } = await genshinOriginalPortraitStatus(baseline, version, signal);
          if (kind === "check" && pending.length) {
            lines.push(`原神角色还有 ${pending.length} 张已核原立绘待补齐。`);
          } else if (pending.length) {
            const { changedAtlasSourceIndexes, downloadAtlasVersionFromIndexes, readSelectedExporterIndexes } =
              await import("./download-legacy-atlas.ts");
            const indexes = await readSelectedExporterIndexes({ gi: version }, signal, request, [{ game: "gi", pageId: "character" }]);
            if ((await changedAtlasSourceIndexes(baseline, indexes, signal)).length) {
              lines.push("原神角色同版索引已变化，本次立绘补齐保留现用快照。");
              return lines.join("\n");
            }
            let recovered = 0;
            const repaired = await downloadAtlasVersionFromIndexes(workspace, root, indexes, async (source, pages) => {
              const { ready } = await genshinOriginalPortraitStatus(join(source, "data"), version, signal);
              recovered = pending.filter((id) => ready.includes(id)).length;
              if (recovered) return applyAtlasCandidate(root, source, pages, signal, active, preparation);
            }, signal, baseline, request);
            lines.push(repaired?.status === "published"
              ? `原神角色已补齐 ${recovered} 张原立绘，发布至快照 ${repaired.version}。`
              : repaired?.status === "prepared" ? `原神角色 ${recovered} 张原立绘已保存到候选 ${repaired.version}，现用图鉴保持原版。`
                : "同版原神角色未发布可用的新立绘，保留现用快照。");
            return lines.join("\n");
          }
        } catch {
          lines.push(signal?.aborted ? "图鉴维护已中止。" : "原神角色原立绘补齐未完成，保留现用快照。");
          return lines.join("\n");
        }
      }

      if (changeCards || (wantsCards && !cardsVersion) || trigger === "challenge" || channel === "latest" || native.length !== scope.length || scope.length === legacyAtlasSourcePages.length ||
          native.some(({ selection }) => {
            const entry = atlasSourcePlan(selection, listing, local, channel).entries[0];
            return entry?.action === "review" && entry.reason === "unproven-upgrade";
          })) {
        if (kind === "check") {
          for (const { game, pageId } of scope) {
            const current = local.pages.find((page) => page.game === game && page.pageId === pageId)?.version;
            const title = native.find(({ selection }) => selection === `${game}/${pageId}`)?.title ?? `${game}/${pageId}`;
            const target = versions[game];
            const summary = !target ? "来源版本未知" : current === target ? `本地版本为 ${target}`
              : `${current ?? "未准备"} → ${target}，待更新`;
            lines.push(`${title} · ${summary}`);
          }
        } else if (missing.length || (wantsCards && !cardsVersion)) {
          lines.push(`未能核实 ${[...new Set([...missing, ...(wantsCards && !cardsVersion ? ["gi"] : [])])].join("、")} 的目标版本，本次范围未发布。`);
        } else if (allCurrent && !changeCards && trigger !== "challenge") {
          lines.push(`本地所选 ${scope.length} 类版本均为目标版本。`);
        } else {
          const updateCount = (allCurrent ? 0 : scope.length) + (changeCards ? 1 : 0);
          try {
            const observed = trigger === "challenge" ? await (await import("./challenge-refresh-plan.ts"))
              .planAtlasChallengeRefresh(baseline, local.pages, scope, versions, signal, request) : undefined;
            if (observed?.length === 0) {
              lines.push("已核对挑战轮换，来源索引与现用资料一致。");
              return lines.join("\n");
            }
            const publishWithCards = async (source?: string, pages: readonly AtlasCandidatePage[] = []) => {
              const stage = await mkdtemp(join(dirname(root), ".atlas-version-cards-"));
              try {
                const { acquireAtlasSource } = await import("./source-acquisition.ts");
                const cards = await acquireAtlasSource(join(stage, "cards"), [
                  { game: "gi", pageId: "gcg", version: cardsVersion },
                ], signal, request);
                if (!source) return await applyAtlasCandidate(root, cards.directory, cards.pages, signal, active, preparation);
                const { assembleAtlasCandidate } = await import("./assemble-candidate.ts");
                const combined = await assembleAtlasCandidate(source, cards.directory, join(stage, "combined"), cards.pages, signal);
                return await applyAtlasCandidate(root, combined.directory, [...pages, ...cards.pages], signal, active, preparation);
              } finally {
                await rm(stage, { recursive: true, force: true }).catch(() => undefined);
              }
            };
            const publish = (source: string, pages: readonly AtlasCandidatePage[]) => changeCards
              ? publishWithCards(source, pages)
              : applyAtlasCandidate(root, source, pages, signal, active, preparation);
            const { downloadAtlasVersion, downloadAtlasVersionFromIndexes } = await import("./download-legacy-atlas.ts");
            const result = observed ? await downloadAtlasVersionFromIndexes(workspace, root, observed, publish, signal, baseline)
              : allCurrent ? await publishWithCards()
              : await (options.downloadVersion ?? downloadAtlasVersion)(workspace, root, versions, publish, signal, request, scope, baseline);
            const coverage = observed ? `轮换变化 ${observed.length} 类`
              : allCurrent ? "七圣召唤" : `所选 ${updateCount} 类`;
            lines.push(result.status === "published" ? `${coverage}已核对并发布至快照 ${result.version}。`
              : `${coverage}未发布，${describeRefresh(result, "")}。`);
          } catch (error) {
            if (signal?.aborted) return "图鉴维护已中止。";
            console.warn("[atlas]", error instanceof Error ? error.message : "图鉴增量更新失败。");
            lines.push(`所选 ${updateCount} 类未完成更新，现用快照仍可用。`);
          }
        }
        return lines.join("\n");
      }

      for (const { selection, title } of native) {
        if (signal?.aborted) { lines.push("图鉴维护已中止。"); break; }
        const entry = atlasSourcePlan(selection, listing, local, channel).entries[0];
        if (!entry || entry.kind !== "versioned") continue;
        let summary: string;
        if (entry.action === "review") summary = reviewReasons[entry.reason];
        else if (entry.action === "current") summary = `已是同一正式版本 ${entry.targetVersion}`;
        else if (kind === "check") summary = `${entry.localVersion} → ${entry.targetVersion}，可准备候选`;
        else {
          try {
            const result = await refreshAtlasSource(root, { selection, preserveRecords: true, expected: active, signal, request,
              channel, manifest: async () => listing, preparation });
            summary = describeRefresh(result, entry.targetVersion);
            if (result.status === "published" || result.status === "prepared") active = acceptedBaseline(result, preparation);
            if (result.status === "busy" || result.status === "stale") {
              lines.push(`${title} · ${summary}`, "其余待更新分类留待下次检查。");
              return lines.join("\n");
            }
          } catch {
            summary = signal?.aborted ? "维护已中止" : "更新未完成，保留现有资料";
          }
        }
        lines.push(`${title} · ${summary}`);
      }
      return lines.join("\n");
    } catch (error) {
      if (error instanceof LegacyAtlasSourceConflict || error instanceof AtlasSnapshotReset) return error.message;
      return signal?.aborted ? "图鉴维护已中止。" : "无法核对图鉴快照，请稍后重试。";
    } finally {
      if (kind === "update") updating = false;
    }
  }

  async function command(kind: "check" | "update", argument: string, context: AtlasMaintenanceContext) {
    if (context.isDelegated || context.atlasMaintenance !== true) return "只有 bot 主人可以操作图鉴更新。";
    if (argument) return `请直接发送 ${kind === "check" ? checkCommand : updateCommand}。`;
    const title = kind === "check" ? "图鉴版本检查" : "图鉴更新结果";
    let started = false;
    const result = await run(kind, policy.version.selections, kind === "update" ? "manual-update" : undefined,
      context.reply && (async () => {
        started = true;
        await feedback(context, kind === "check" ? "正在检查图鉴版本差异。" : syncAfterUpdate
          ? "正在检查图鉴版本，随后增量更新有变化的分类。" : "正在检查图鉴版本，有变化的分类将保存到候选目录。");
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
    const [lead = "维护完成。", ...contents] = rows;
    const card = await renderAtlasStatus(title, lead, contents, context.inlineImageByteLimit);
    if (typeof card === "string" || signal?.aborted || !await feedback(context, card)) return result;
    return [];
  }

  async function reset(argument: string, context: AtlasMaintenanceContext) {
    if (context.isDelegated || context.atlasMaintenance !== true) return "只有 bot 主人可以重置图鉴。";
    if (argument) return `请直接发送 ${resetCommand}。`;
    if (dataOverride) return "当前使用显式图鉴数据目录，请通过本地运维管理该目录。";
    if (updating) return "已有图鉴更新正在进行，请稍后再试。";
    updating = true;
    let summary: string;
    try {
      const result = await resetAtlasSnapshot(root, signal);
      if (result.status === "busy") return "已有图鉴发布正在进行，请稍后再试。";
      summary = result.status === "empty" ? "没有可重置的主图鉴快照。"
        : "图鉴已重置，源文件和历次快照仍可恢复。请发送 #全量更新图鉴 重新初始化。";
    } catch {
      summary = signal?.aborted ? "图鉴重置已中止。" : "无法重置图鉴，保留现有资料。";
    } finally {
      updating = false;
    }
    return presentResult(context, "图鉴重置结果", summary);
  }

  async function fullUpdate(argument: string, context: AtlasMaintenanceContext) {
    if (context.isDelegated || context.atlasMaintenance !== true) return "只有 bot 主人可以操作图鉴更新。";
    if (argument) return `请直接发送 ${fullCommand}。`;
    if (dataOverride) return "当前使用显式图鉴数据目录，请通过本地运维更新该目录。";
    if (signal?.aborted) return "图鉴维护已中止。";
    if (channel !== "live" && channel !== "latest") return "图鉴 version_channel 须为 live 或 latest，请先修正配置。";
    if (updating) return "已有图鉴更新正在进行，请稍后再试。";
    updating = true;
    let result: string;
    try {
      if (context.reply) await feedback(context, "正在全量核对三款游戏图鉴，首次初始化可能需要较长时间。");
      result = await runFullUpdate(channel);
    } finally {
      updating = false;
    }
    return presentResult(context, "图鉴全量更新结果", result);
  }

  async function runFullUpdate(channel: AtlasVersionChannel) {
    let existing = false;
    const preparation: AtlasPreparation | undefined = syncAfterUpdate ? undefined : {};
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      existing = await readAtlasSnapshotVersion(root) !== null || await hasLegacyAtlasData(root);
      if (existing) {
        const { refreshFullAtlasFromPublic } = await import("./full-refresh.ts");
        const result = await refreshFullAtlasFromPublic(root, workspace, channel, manifest, request, signal, preparation);
        if (result.status === "current") return "三款游戏的全部 30 类图鉴已重新核对，和现用资料一致。";
        if (result.status === "published") return `三款游戏的全部 30 类图鉴已更新，发布至快照 ${result.version}。`;
        if (result.status === "review") {
          if (result.reason === "manifest") return "未能核实三款游戏的目标版本，保留现用图鉴。";
          if (result.reason === "older") return "所选渠道有分类低于现用版本或版本无法比较，保留现用图鉴。";
          return "现用图鉴资料无法核实，请先检查本地快照。";
        }
        if (result.status === "invalid") {
          console.warn("[atlas]", result.issues[0] ?? "图鉴全量更新候选校验未通过。");
          return "全量图鉴候选校验未通过，保留现用资料。";
        }
        return `${describeRefresh(result, "")}。`;
      }
      const donor = configuredChannel === undefined ? await findLegacyAtlasExport(root) : undefined;
      const result = donor ? await initializeAtlas(root, donor, signal, preparation)
        : await initializeAtlasFromPublic(root, workspace, signal, channel, { manifest, request, preparation });
      if (result.status === "published" || result.status === "prepared") {
        const initial = result.status === "published" ? `图鉴初始化完成，已发布第 ${result.version} 版。`
          : `图鉴初始化候选 ${result.version} 已保存，尚未发布至现用目录。`;
        if (!donor) return initial;
        const next = await refreshAtlasSource(root, { selection: atlasGenshinCardSelection, channel, signal, request, manifest,
          expected: acceptedBaseline(result, preparation), preparation }).catch(() => undefined);
        if (next?.status === "published") return `${initial}七圣召唤已发布至第 ${next.version} 版。`;
        if (next?.status === "prepared") return `${initial}七圣召唤已保存到候选 ${next.version}。`;
        if (next?.status === "current") return initial;
        return `${initial}七圣召唤待更新，可发送 ${updateCommand} 重试。`;
      }
      if (result.status === "stale") return "现用快照已切换，本次候选未发布。";
      if (result.status === "busy") return "已有图鉴发布正在进行，请稍后再试。";
      return "图鉴候选校验未通过，保留现有资料。";
    } catch (error) {
      if (error instanceof LegacyAtlasSourceConflict) return error.message;
      if (signal?.aborted) return "图鉴维护已中止。";
      if (existing) {
        console.warn("[atlas]", error instanceof Error ? error.message : "图鉴全量更新失败。");
        return "未完成全量图鉴更新，保留现用资料。";
      }
      return "图鉴初始化未完成，已保留现有资料和下载工作目录。";
    }
  }

  function scheduled(kind: AtlasScheduleKind) {
    const { cron, issue, selections } = policy[kind];
    return { cron, issue, run: () => cron ? run("update", selections, kind) : Promise.resolve("图鉴自动更新未启用。") };
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
