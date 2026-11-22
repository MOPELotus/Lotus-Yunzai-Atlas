import { createHash } from "node:crypto";

class SourceNumber {
  constructor(readonly text: string) {}
}

export type EvidenceJson = null | boolean | string | SourceNumber | readonly EvidenceJson[] | { readonly [key: string]: EvidenceJson };
type Json = EvidenceJson;
const parseWithSource = JSON.parse as (source: string, revive: (key: string, value: unknown, context?: { source?: string }) => unknown) => unknown;

export function parseLegacyJsonEvidence(source: string): Json {
  return parseWithSource(source, (_key, value, context) => {
    if (typeof value !== "number") return value;
    if (context?.source === undefined) throw new Error("当前运行时无法保留图鉴 JSON 原数字。");
    return new SourceNumber(context.source);
  }) as Json;
}

export function evidenceObject(value: Json): Readonly<Record<string, Json>> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof SourceNumber)
    ? value as Readonly<Record<string, Json>> : {};
}

export function legacyEvidenceType(value: Json) {
  return value instanceof SourceNumber ? "number" : value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

export function serializeLegacyJsonEvidence(value: Json, sortKeys = false): string {
  return serializeEvidence(value, sortKeys, false);
}

function serializeEvidence(value: Json, sortKeys: boolean, normalizeNumbers: boolean): string {
  if (value instanceof SourceNumber) return normalizeNumbers ? decimal(value.text) : value.text;
  if (Array.isArray(value)) return `[${value.map((item) => serializeEvidence(item, sortKeys, normalizeNumbers)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = evidenceObject(value);
    const keys = Object.keys(entries);
    if (sortKeys) keys.sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${serializeEvidence(entries[key]!, sortKeys, normalizeNumbers)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function legacyEvidenceDigest(value: Json): string {
  return createHash("sha256").update(serializeLegacyJsonEvidence(value, true)).digest("hex");
}

function decimal(value: string) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(value)!;
  const [, sign, integer, fraction = "", exponent = "0"] = match;
  const digits = `${integer}${fraction}`.replace(/^0+/u, "");
  if (!digits) return "0";
  if (exponent.length > 128) throw new Error("图鉴 JSON 数字指数超出可比较范围。");
  let end = digits.length;
  while (digits[end - 1] === "0") end--;
  return `${sign}${digits.slice(0, end)}e${BigInt(exponent) + BigInt(digits.length - end - fraction.length)}`;
}

/** Ignore JSON formatting while retaining every significant decimal digit. */
export function legacyEffectiveEvidenceDigest(value: Json): string {
  return createHash("sha256").update(serializeEvidence(value, true, true)).digest("hex");
}

export function compareLegacyJsonEvidence(old: Json, source: Json) {
  const differences: { path: string; kind: "legacy-integer-rounding" | "different"; oldNumber?: string; sourceNumber?: string }[] = [];
  let differenceCount = 0;
  let roundingCount = 0;
  function visit(old: Json | undefined, source: Json | undefined, path: readonly string[]) {
    if (old === source) return;
    if (old instanceof SourceNumber && source instanceof SourceNumber) {
      if (decimal(old.text) === decimal(source.text)) return;
      const sourceValue = Number(source.text);
      if (path.at(-1) === "stage_name" && /^-?\d+$/u.test(source.text) && Number.isFinite(sourceValue) &&
          !Number.isSafeInteger(sourceValue) && old.text === JSON.stringify(sourceValue)) {
        record("legacy-integer-rounding", path, old.text, source.text);
      } else record("different", path, old.text, source.text);
      return;
    }
    if (Array.isArray(old) && Array.isArray(source) && old.length === source.length) {
      old.forEach((value, index) => visit(value, source[index], [...path, String(index)]));
      return;
    }
    if (old !== null && source !== null && typeof old === "object" && typeof source === "object" &&
        !Array.isArray(old) && !Array.isArray(source) && !(old instanceof SourceNumber) && !(source instanceof SourceNumber)) {
      const left = evidenceObject(old), right = evidenceObject(source);
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        visit(Object.hasOwn(left, key) ? left[key] : undefined, Object.hasOwn(right, key) ? right[key] : undefined, [...path, key]);
      }
      return;
    }
    record("different", path);
  }

  function record(kind: "legacy-integer-rounding" | "different", path: readonly string[], oldNumber?: string, sourceNumber?: string) {
    differenceCount++;
    if (kind === "legacy-integer-rounding") roundingCount++;
    if (differences.length >= 64) return;
    differences.push({ path: path.map((part) => `/${part.replace(/~/gu, "~0").replace(/\//gu, "~1")}`).join(""), kind,
      oldNumber, sourceNumber });
  }

  visit(old, source, []);
  return { status: differenceCount === 0 ? "exact" : differenceCount === roundingCount ? "legacy-integer-rounding" : "different",
    differenceCount, roundingCount, differences } as const;
}
