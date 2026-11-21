import { discoverRuntimeAtlasDataDirectory, findLegacyAtlasExport, LegacyAtlasSourceConflict } from "./legacy-atlas-directory.ts";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atlasSourcePlan, atlasSourceSelections, refreshAtlasSource, type AtlasRefreshOptions,
  type AtlasSourceRefresh, type SourceSelection } from "./refresh-source.ts";
import { AtlasSnapshotReset, discoverAtlasDataDirectory } from "./snapshot-pointer.ts";
import { hasLegacyAtlasData, readAtlasSnapshotVersion, resetAtlasSnapshot } from "./publish-candidate.ts";
import { initializeAtlas, initializeAtlasFromPublic } from "./initialize-atlas.ts";
import { atlasManifestVersion, fetchAtlasManifest } from "./update-plan.ts";
import { validateAtlasCandidate, type AtlasCandidatePage } from "./validate-candidate.ts";
import { object } from "./source-values.ts";
import { atlasExportSelections, atlasGenshinCardSelection, parseAtlasUpdatePolicy, type AtlasScheduleKind } from "./update-policy.ts";
import { legacyAtlasSourcePages } from "./legacy-source-profile.ts";
import { applyAtlasCandidate } from "./apply-candidate.ts";

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
}

interface AtlasMaintenanceContext {
  readonly atlasMaintenance?: true;
  readonly isDelegated?: boolean;
}

export function createAtlasMaintenance(root: string, options: AtlasMaintenanceOptions = {}) {
  const { signal, request, dataOverride, manifest = fetchAtlasManifest } = options;
  const policy = parseAtlasUpdatePolicy(options.updateConfig);
  const configuredChannel = object(options.updateConfig).version_channel;
  const channel = configuredChannel === undefined ? "latest" : configuredChannel;
  const workspace = join(dirname(root), "atlas-download");
  let updating = false;

  async function run(kind: "check" | "update", selections: readonly string[], scheduledKind?: AtlasScheduleKind) {
    if (signal?.aborted) return "图鉴维护已中止。";
    if (!selections.length) return "图鉴配置未选中已核实的分类。";
    if (channel !== "live" && channel !== "latest") return "图鉴 version_channel 须为 live 或 latest，请先修正配置。";
    if (kind === "update" && dataOverride) return "当前使用显式图鉴数据目录，请通过本地运维更新该目录。";
    if (updating) return "已有图鉴更新正在进行，请稍后再试。";
    if (kind === "update") updating = true;
    try {
      let active = dataOverride ? undefined : await discoverAtlasDataDirectory(root).catch(() => undefined);
      let baseline = dataOverride ? await realpath(dataOverride).catch(() => undefined) : active?.root;
      if (!baseline) {
        if (!dataOverride) {
          const fallback = await discoverRuntimeAtlasDataDirectory(root).catch((error: unknown) => {
            if (error instanceof LegacyAtlasSourceConflict || error instanceof AtlasSnapshotReset) throw error;
          });
          if (fallback?.legacy === true) return "当前图鉴只读使用旧版导出。请先运行本地初始化，再管理更新。";
        }
        return "图鉴数据未初始化或无法验证，请先准备完整快照。";
      }

      let local = await validateAtlasCandidate(baseline, [], signal);
      if (!local.ok) return "图鉴数据未初始化或无法验证，请先准备完整快照。";
      const listing = await manifest(signal).catch(() => undefined);
      if (signal?.aborted) return "图鉴维护已中止。";
      if (!listing) return "图鉴版本清单不可用，保留现有资料。";
      const lines = [kind === "check" ? "图鉴版本检查" : "图鉴更新结果"];
      if (selections.includes(atlasGenshinCardSelection)) {
        const selection = atlasGenshinCardSelection;
        const entry = atlasSourcePlan(selection, listing, local, channel).entries[0];
        if (entry?.kind === "versioned") {
          let summary: string;
          if (entry.action === "review") summary = reviewReasons[entry.reason];
          else if (entry.action === "current") summary = `已是同一版本 ${entry.targetVersion}`;
          else if (kind === "check") summary = `${entry.localVersion ?? "未准备"} → ${entry.targetVersion}，可准备候选`;
          else {
            try {
              const result = await refreshAtlasSource(root, { selection, expected: active, signal, request, channel, manifest: async () => listing });
              summary = describeRefresh(result, entry.targetVersion);
              if (result.status === "published") {
                active = { version: result.version, root: result.directory };
                baseline = result.directory;
                local = await validateAtlasCandidate(baseline, [], signal);
                if (!local.ok) return [...lines, `七圣召唤 · ${summary}`, "无法核对更新后的快照，已停止其他更新。"].join("\n");
              } else if (result.status === "busy" || result.status === "stale") {
                return [...lines, `七圣召唤 · ${summary}`, "其余待更新分类留待下次检查。"].join("\n");
              }
            } catch {
              summary = signal?.aborted ? "维护已中止" : "更新未完成，保留现有资料";
            }
          }
          lines.push(`七圣召唤 · ${summary}`);
        }
      }
      const scope = legacyAtlasSourcePages.filter(({ game, pageId }) => selections.includes(`${game}/${pageId}`));
      if (!scope.length || signal?.aborted) return lines.join("\n");
      const native = atlasSourceSelections.filter(({ selection }) => selection !== atlasGenshinCardSelection && selections.includes(selection));
      const versions = Object.fromEntries([...new Set(scope.map(({ game }) => game))]
        .map((game) => [game, atlasManifestVersion(listing, game, channel)]));
      const missing = Object.entries(versions).filter(([, version]) => !version).map(([game]) => game);
      const allCurrent = scope.every(({ game, pageId }) =>
        versions[game] && local.pages.some((page) => page.game === game && page.pageId === pageId && page.version === versions[game]));
      const targetNotes = Object.entries(versions).map(([game, version]) => `${game} ${version ?? "版本未知"}`).join("、");
      const channelLabel = channel === "live" ? "正式版" : "网站最新版";
      lines.push(`${channelLabel} · ${targetNotes} · 本次范围 ${scope.length} 类`);

      if (allCurrent && scheduledKind !== "challenge" &&
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
              if (recovered) return applyAtlasCandidate(root, source, pages, signal, active);
            }, signal, baseline, request);
            lines.push(repaired?.status === "published"
              ? `原神角色已补齐 ${recovered} 张原立绘，发布至快照 ${repaired.version}。`
              : "同版原神角色未发布可用的新立绘，保留现用快照。");
            return lines.join("\n");
          }
        } catch {
          lines.push(signal?.aborted ? "图鉴维护已中止。" : "原神角色原立绘补齐未完成，保留现用快照。");
          return lines.join("\n");
        }
      }

      if (scheduledKind === "challenge" || channel === "latest" || native.length !== scope.length || scope.length === legacyAtlasSourcePages.length ||
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
        } else if (missing.length) {
          lines.push(`未能核实 ${missing.join("、")} 的目标版本，本次范围未发布。`);
        } else if (allCurrent && scheduledKind !== "challenge") {
          lines.push(`本地所选 ${scope.length} 类版本均为目标版本。`);
        } else {
          try {
            const observed = scheduledKind === "challenge" ? await (await import("./challenge-refresh-plan.ts"))
              .planAtlasChallengeRefresh(baseline, local.pages, scope, versions, signal, request) : undefined;
            if (observed?.length === 0) {
              lines.push("已核对挑战轮换，来源索引与现用资料一致。");
              return lines.join("\n");
            }
            const { downloadAtlasVersion, downloadAtlasVersionFromIndexes } = await import("./download-legacy-atlas.ts");
            const publish = (source: string, pages: readonly AtlasCandidatePage[]) =>
              applyAtlasCandidate(root, source, pages, signal, active);
            const result = observed ? await downloadAtlasVersionFromIndexes(workspace, root, observed, publish, signal, baseline)
              : await downloadAtlasVersion(workspace, root, versions, publish, signal, request, scope, baseline);
            const coverage = observed ? `轮换变化 ${observed.length} 类` : `所选 ${scope.length} 类`;
            lines.push(result.status === "published" ? `${coverage}已核对并发布至快照 ${result.version}。`
              : `${coverage}未发布，${describeRefresh(result, "")}。`);
          } catch (error) {
            if (signal?.aborted) return "图鉴维护已中止。";
            console.warn("[atlas]", error instanceof Error ? error.message : "图鉴增量更新失败。");
            lines.push(`所选 ${scope.length} 类未完成更新，现用快照仍可用。`);
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
              channel, manifest: async () => listing });
            summary = describeRefresh(result, entry.targetVersion);
            if (result.status === "published") active = { version: result.version, root: result.directory };
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

  function command(kind: "check" | "update", argument: string, context: AtlasMaintenanceContext) {
    if (context.isDelegated || context.atlasMaintenance !== true) return "只有 bot 主人可以操作图鉴更新。";
    if (argument) return `请直接发送 ${kind === "check" ? checkCommand : updateCommand}。`;
    return run(kind, policy.version.selections);
  }

  async function reset(argument: string, context: AtlasMaintenanceContext) {
    if (context.isDelegated || context.atlasMaintenance !== true) return "只有 bot 主人可以重置图鉴。";
    if (argument) return `请直接发送 ${resetCommand}。`;
    if (dataOverride) return "当前使用显式图鉴数据目录，请通过本地运维管理该目录。";
    if (updating) return "已有图鉴更新正在进行，请稍后再试。";
    updating = true;
    try {
      const result = await resetAtlasSnapshot(root, signal);
      if (result.status === "busy") return "已有图鉴发布正在进行，请稍后再试。";
      if (result.status === "empty") return "没有可重置的主图鉴快照。";
      return "图鉴已重置，源文件和历次快照仍可恢复。请重新初始化图鉴。";
    } catch {
      return signal?.aborted ? "图鉴重置已中止。" : "无法重置图鉴，保留现有资料。";
    } finally {
      updating = false;
    }
  }

  async function fullUpdate(argument: string, context: AtlasMaintenanceContext) {
    if (context.isDelegated || context.atlasMaintenance !== true) return "只有 bot 主人可以操作图鉴更新。";
    if (argument) return `请直接发送 ${fullCommand}。`;
    if (dataOverride) return "当前使用显式图鉴数据目录，请通过本地运维更新该目录。";
    if (signal?.aborted) return "图鉴维护已中止。";
    if (channel !== "live" && channel !== "latest") return "图鉴 version_channel 须为 live 或 latest，请先修正配置。";
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      if (await readAtlasSnapshotVersion(root) !== null || await hasLegacyAtlasData(root)) {
        return run("update", atlasExportSelections);
      }
    } catch {
      return "图鉴发布目录不可用，保留现有资料。";
    }
    if (updating) return "已有图鉴更新正在进行，请稍后再试。";
    updating = true;
    try {
      const donor = configuredChannel === undefined ? await findLegacyAtlasExport(root) : undefined;
      const result = donor ? await initializeAtlas(root, donor, signal)
        : await initializeAtlasFromPublic(root, workspace, signal, channel, { manifest, request });
      if (result.status === "published") {
        const initial = `图鉴初始化完成，已发布第 ${result.version} 版。`;
        if (!donor) return initial;
        const next = await refreshAtlasSource(root, { selection: atlasGenshinCardSelection, channel, signal, request, manifest,
          expected: { version: result.version, root: result.directory } }).catch(() => undefined);
        if (next?.status === "published") return `${initial}七圣召唤已发布至第 ${next.version} 版。`;
        if (next?.status === "current") return initial;
        return `${initial}七圣召唤待更新，可发送 ${updateCommand} 重试。`;
      }
      if (result.status === "stale") return "现用快照已切换，本次候选未发布。";
      if (result.status === "busy") return "已有图鉴发布正在进行，请稍后再试。";
      return "图鉴候选校验未通过，保留现有资料。";
    } catch (error) {
      if (error instanceof LegacyAtlasSourceConflict) return error.message;
      if (signal?.aborted) return "图鉴维护已中止。";
      return "图鉴初始化未完成，已保留现有资料和下载工作目录。";
    } finally {
      updating = false;
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
