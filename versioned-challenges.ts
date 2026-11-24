import { atlasSourceOrigin, readAtlasSourceBytes, type AtlasSourceFetch } from "./source-transport.ts";
import { atlasManifestVersion, fetchAtlasManifest } from "./update-plan.ts";
import { object } from "./source-values.ts";

type Period = "current" | "previous" | "next";
const knownArbitration = { "4.5": [9], "4.6": [10], "4.7": [11], unknown: [12] };

function knownLiveVersion(at: number) {
  // Official 4.6 and 4.7 handovers. Leave the maintenance window unassigned.
  if (Date.parse("2026-09-28T11:00:00+08:00") <= at && at < Date.parse("2026-11-11T06:00:00+08:00")) return "4.6";
  if (Date.parse("2026-11-11T11:00:00+08:00") <= at && at < Date.parse("2026-12-23T06:00:00+08:00")) return "4.7";
}

function release(version: string): string {
  return version.split(".").slice(0, 2).join(".");
}

function compareReleases(a: string, b: string): number {
  const [majorA = 0, minorA = 0] = a.split(".").map(Number);
  const [majorB = 0, minorB = 0] = b.split(".").map(Number);
  return majorA - majorB || minorA - minorB;
}

export function selectArbitrationId(liveVersion: string, data: unknown, period: Period): string | undefined {
  const live = release(liveVersion);
  const mapping = object(data);
  const versions = Object.keys(mapping).filter(key => /^(?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)$/u.test(key)).sort(compareReleases);
  const index = versions.indexOf(live);
  if (index < 0) return;
  function single(key: string | undefined) {
    const ids = key && mapping[key];
    if (Array.isArray(ids) && ids.length === 1 && Number.isSafeInteger(ids[0]) && ids[0] > 0) return ids[0] as number;
  }
  const current = single(live);
  if (current === undefined) return;
  if (period === "current") return String(current);
  const adjacent = single(versions[index + (period === "next" ? 1 : -1)] ?? (period === "next" ? "unknown" : undefined));
  if (adjacent === current + (period === "next" ? 1 : -1)) return String(adjacent);
}

export function createArbitrationLookup(manifest = fetchAtlasManifest, request: AtlasSourceFetch = fetch, clock = Date.now) {
  let cached: { snapshot: string; expires: number; source: Promise<{ live: string; mapping: unknown } | undefined> } | undefined;
  return async (snapshot: string, period: Period, now?: number): Promise<string | undefined> => {
    const known = knownLiveVersion(now ?? clock());
    if (known) return selectArbitrationId(known, knownArbitration, period);
    if (now !== undefined || !/^[0-9]+[.][0-9]+(?:[.][0-9]+){0,2}$/u.test(snapshot)) return;
    if (cached?.snapshot !== snapshot || cached.expires <= clock()) {
      const source = (async () => {
        const sourceManifest = await manifest();
        const live = atlasManifestVersion(sourceManifest, "hsr", "live");
        if (!live) return;
        const available = object(object(sourceManifest).hsr).available;
        if (!Array.isArray(available) || !available.includes(snapshot)) return;
        const source = await readAtlasSourceBytes(`${atlasSourceOrigin}/hsr/${snapshot}/peak/version.json`,
          "application/json", 64 * 1024, false, undefined, request);
        if (source) return { live, mapping: JSON.parse(source.toString("utf8")) as unknown };
      })().catch(() => undefined);
      const entry = { snapshot, expires: clock() + 5 * 60_000, source };
      cached = entry;
      void source.then(data => { if (!data) entry.expires = clock() + 15_000; });
    }
    const data = await cached.source;
    if (data) return selectArbitrationId(data.live, data.mapping, period);
  };
}
