import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { hasExactLegacyDetailIdentity } from "./legacy-coverage.ts";
import { planLegacyDetailQueue, type LegacyDetailQueueEntry } from "./legacy-detail-queue.ts";
import { openAtlasCheckpointDirectory } from "./pinned-source-cache.ts";
import { readAtlasSourceBytes, type AtlasSourceFetch } from "./source-transport.ts";
import { object } from "./source-values.ts";

const maxRequestsPerRun = 8;
const detailBytes = 1024 * 1024;
const envelopeBytes = Math.ceil(detailBytes / 3) * 4 + 4096;
const candidateFilename = /^[a-f0-9]{64}\.[a-f0-9]{64}\.candidate\.json$/u;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function hash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function contains(parent: string, child: string): boolean {
  const location = relative(parent, child);
  return !isAbsolute(location) && location.split(sep)[0] !== "..";
}

function detailMatches(entry: LegacyDetailQueueEntry, bytes: Uint8Array): boolean {
  try {
    const value: unknown = JSON.parse(utf8.decode(bytes));
    const { level } = object(value);
    return hasExactLegacyDetailIdentity(value, entry.id, entry.name) && Array.isArray(level) && level.length > 0;
  } catch {
    return false;
  }
}

function decodeEvidence(entry: LegacyDetailQueueEntry, bytes: Buffer | undefined) {
  if (!bytes) return;
  try {
    const data = object(JSON.parse(utf8.decode(bytes)));
    const { kind, key, url, version, sha256, bodyBase64 } = data;
    if (kind !== "candidate" || key !== entry.key || url !== entry.url || version !== entry.version || typeof bodyBase64 !== "string") return;
    const body = Buffer.from(bodyBase64, "base64");
    if (typeof sha256 !== "string" || body.length !== data.bytes || body.length > detailBytes || body.toString("base64") !== bodyBase64 ||
        hash(body) !== sha256 || !detailMatches(entry, body)) return;
    return { sha256, bytes: body.length, body };
  } catch {
    return;
  }
}

function checkpointPrefix(entry: LegacyDetailQueueEntry): string {
  return `${hash(JSON.stringify([entry.key, entry.url, entry.name]))}.`;
}

export async function readLegacyDetailCandidate(entry: LegacyDetailQueueEntry, path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const file = basename(path);
  const directory = await realpath(dirname(path));
  if (!candidateFilename.test(file) || !file.startsWith(checkpointPrefix(entry))) throw new Error("候选文件名与固定条目身份不符。");
  const cache = await openAtlasCheckpointDirectory(directory, candidateFilename);
  const candidate = decodeEvidence(entry, await cache.read(file, envelopeBytes, signal));
  if (!candidate || file !== `${checkpointPrefix(entry)}${candidate.sha256}.candidate.json`) throw new Error("详情候选未通过原字节复核。");
  return candidate;
}

/** Capture candidate bytes only. A locally computed digest does not establish independent source pinning. */
export async function captureLegacyDetails(exportRoot: string, indexCache: string, destination: string, {
  maxRequests = 1, requested, signal, request = fetch,
}: {
  readonly maxRequests?: number;
  readonly requested?: readonly string[];
  readonly signal?: AbortSignal;
  readonly request?: AtlasSourceFetch;
} = {}) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 0 || maxRequests > maxRequestsPerRun) {
    throw new Error(`图鉴详情候选请求次数须在 0 到 ${maxRequestsPerRun} 之间。`);
  }
  if (!destination.trim() || /^[a-z][a-z0-9+.-]*:\/\//iu.test(destination)) throw new Error("请指定独立的本地图鉴详情候选目录。");
  const resolved = resolve(destination);
  const [reference, indexes, parent] = await Promise.all([realpath(exportRoot), realpath(indexCache), realpath(dirname(resolved))]);
  const target = join(parent, basename(resolved));
  if ([reference, indexes].some((path) => contains(path, target) || contains(target, path))) {
    throw new Error("详情候选须与原导出及原索引检查点分开保存。");
  }
  const queue = await planLegacyDetailQueue(reference, indexes, signal);
  const eligible = queue.entries.filter(({ state }) => state === "eligible-candidate");
  if (requested && (new Set(requested).size !== requested.length || requested.some((key) => !eligible.some((entry) => entry.key === key)))) {
    throw new Error("请求中含重复条目或没有可核实身份的图鉴详情候选。");
  }
  const selected = requested ? eligible.filter(({ key }) => requested.includes(key)) : eligible;
  const cache = await openAtlasCheckpointDirectory(target, candidateFilename);
  async function readCandidates(entry: LegacyDetailQueueEntry, prefix: string) {
    const candidates = [];
    for (const file of (await cache.names()).filter((file) => file.startsWith(prefix)).sort()) {
      const candidate = decodeEvidence(entry, await cache.read(file, envelopeBytes, signal));
      if (candidate && file === `${prefix}${candidate.sha256}.candidate.json`) {
        candidates.push({ file, evidence: { sha256: candidate.sha256, bytes: candidate.bytes } });
      }
    }
    return candidates;
  }
  let requests = 0;
  const records = [];
  for (const entry of selected) {
    signal?.throwIfAborted();
    const prefix = checkpointPrefix(entry);
    let candidates = await readCandidates(entry, prefix);
    let state: "candidate-cached" | "candidate-captured" | "candidate-conflict" | "pending" | "request-failed" | "identity-mismatch" =
      candidates.length ? "candidate-cached" : "pending";
    if (!candidates.length && requests < maxRequests) {
      requests++;
      const bytes = await readAtlasSourceBytes(entry.url, "application/json", detailBytes, false, signal, request).catch(() => undefined);
      signal?.throwIfAborted();
      if (!bytes) state = "request-failed";
      else if (!detailMatches(entry, bytes)) state = "identity-mismatch";
      else {
        const evidence = { sha256: hash(bytes), bytes: bytes.length };
        const content = { kind: "candidate", key: entry.key, url: entry.url, version: entry.version, ...evidence, bodyBase64: bytes.toString("base64") };
        await cache.write(`${prefix}${evidence.sha256}.candidate.json`, Buffer.from(`${JSON.stringify(content)}\n`), signal);
        candidates = await readCandidates(entry, prefix);
        state = candidates.length ? "candidate-captured" : "pending";
      }
    }
    if (candidates.length > 1) state = "candidate-conflict";
    const match = candidates.length === 1 ? candidates[0] : undefined;
    records.push({ key: entry.key, version: entry.version, url: entry.url, state, evidence: match?.evidence, checkpoint: match?.file,
      conflictingShas: state === "candidate-conflict" ? candidates.map(({ evidence }) => evidence.sha256) : undefined });
  }
  return { origin: "candidate-only", requests, records, candidateFiles: records.filter(({ evidence }) => evidence !== undefined).length } as const;
}

if (import.meta.main) {
  const [source, cache, destination, budget, ...requested] = Bun.argv.slice(2);
  if (!source || !cache || !destination || budget === undefined || !/^\d+$/u.test(budget)) {
    console.error("用法：bun capture-legacy-details.ts <原导出根> <索引检查点目录> <候选目录> <0至8次> [游戏/分类/ID ...]");
    process.exitCode = 2;
  } else {
    try {
      const result = await captureLegacyDetails(source, cache, destination, { maxRequests: Number(budget), requested: requested.length ? requested : undefined });
      console.log(JSON.stringify(result, null, 2));
      if (result.records.some(({ state }) => state === "request-failed" || state === "identity-mismatch" || state === "candidate-conflict")) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : "无法保存图鉴详情候选。");
      process.exitCode = 1;
    }
  }
}
