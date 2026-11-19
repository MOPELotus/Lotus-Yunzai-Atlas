import { realpath } from "node:fs/promises";
import { atlasSourcePlan, atlasSourceSelections, refreshAtlasSource, type AtlasRefreshOptions,
  type AtlasSourceRefresh, type SourceSelection } from "./refresh-source.ts";
import { discoverAtlasDataDirectory } from "./snapshot-pointer.ts";
import { fetchAtlasManifest } from "./update-plan.ts";
import { validateAtlasCandidate } from "./validate-candidate.ts";
import { object } from "./source-values.ts";
import { parseAtlasUpdatePolicy, type AtlasScheduleKind } from "./update-policy.ts";

const checkCommand = "#检查图鉴更新";
const updateCommand = "#更新图鉴";
const prefixes = ["", "Lotus", "lotus", "荷花"];
const names = [[checkCommand, "检查图鉴更新", "图鉴检查更新"], [updateCommand, "更新图鉴", "图鉴更新"]] as const;

export const atlasMaintenanceAliases = Object.fromEntries(names.flatMap(([target, ...words]) =>
  ["", "#"].flatMap((hash) => prefixes.flatMap((prefix) => words.flatMap((word) => {
    const alias = `${hash}${prefix}${word}`;
    return alias === target ? [] : [[alias, target]];
  })))));

function publishedManifest(value: unknown) {
  return Object.fromEntries(["gi", "hsr", "zzz"].map((game) => {
    const { live, available } = object(object(value)[game]);
    return [game, { live, latest: live, available }];
  }));
}

const reviewReasons = {
  "local-unverified": "现有分类不完整，保留现有资料",
  "manifest-unavailable": "未能核实正式来源版本",
  "unproven-upgrade": "正式源版本低于现有版本或无法比较，保留现有资料",
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
  let updating = false;

  async function run(kind: "check" | "update", selections: readonly SourceSelection[]) {
    if (signal?.aborted) return "图鉴维护已中止。";
    if (!selections.length) return "图鉴配置未选中已核实的分类。";
    if (kind === "update" && dataOverride) return "当前使用显式图鉴数据目录，请通过本地运维更新该目录。";
    if (updating) return "已有图鉴更新正在进行，请稍后再试。";
    if (kind === "update") updating = true;
    try {
      let active = dataOverride ? undefined : await discoverAtlasDataDirectory(root).catch(() => undefined);
      const baseline = dataOverride ? await realpath(dataOverride).catch(() => undefined) : active?.root;
      if (!baseline) return "图鉴数据未初始化或无法验证，请先准备完整快照。";

      const local = await validateAtlasCandidate(baseline, [], signal);
      if (!local.ok) return "图鉴数据未初始化或无法验证，请先准备完整快照。";
      const listing = await manifest(signal).catch(() => undefined);
      if (signal?.aborted) return "图鉴维护已中止。";
      if (!listing) return "图鉴版本清单不可用，保留现有资料。";
      const release = publishedManifest(listing);
      const lines = [kind === "check" ? "图鉴版本检查" : "图鉴更新结果"];
      for (const { selection, title } of atlasSourceSelections) {
        if (!selections.includes(selection)) continue;
        if (signal?.aborted) { lines.push("图鉴维护已中止。"); break; }
        const entry = atlasSourcePlan(selection, release, local).entries[0];
        if (!entry || entry.kind !== "versioned") continue;
        let summary: string;
        if (entry.action === "review") summary = reviewReasons[entry.reason];
        else if (entry.action === "current") summary = `已是同一正式版本 ${entry.targetVersion}`;
        else if (kind === "check") summary = `${entry.localVersion} → ${entry.targetVersion}，可准备候选`;
        else {
          try {
            const result = await refreshAtlasSource(root, { selection, preserveRecords: true, expected: active, signal, request,
              manifest: async () => release });
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
      if (selections.length === atlasSourceSelections.length) lines.push("其余分类尚待核对来源。");
      return lines.join("\n");
    } catch {
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

  function scheduled(kind: AtlasScheduleKind) {
    const { cron, issue, selections } = policy[kind];
    return { cron, issue, run: () => cron ? run("update", selections) : Promise.resolve("图鉴自动更新未启用。") };
  }

  return {
    commands: {
      [checkCommand]: (argument: string, context: AtlasMaintenanceContext) => command("check", argument, context),
      [updateCommand]: (argument: string, context: AtlasMaintenanceContext) => command("update", argument, context),
    },
    atlasSchedule: { version: scheduled("version"), challenge: scheduled("challenge") },
  };
}
