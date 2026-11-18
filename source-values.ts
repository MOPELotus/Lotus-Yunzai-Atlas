export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function label(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function compareKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function effectText(
  value: unknown, parameters?: readonly unknown[], bareParameters = false,
): string {
  const text = label(value).replace(/<\/?(?:unbreak|color(?:=[^>]*)?|u)>/giu, "").replace(/\\n/gu, "\n");
  const resolved = text.replace(/#(\d+)(?:\[(i|m|f[0-4])\])?(%?)(?![\d%\[])/gu,
    (placeholder, index, format, unit) => {
      const parameter = parameters?.[Number(index) - 1];
      if (typeof parameter !== "number" || !Number.isFinite(parameter)) return placeholder;
      // A bare percentage is stored in percentage points, a typed one as a ratio.
      if (format === "i") return (parameter * (unit ? 100 : 1)).toFixed(0) + unit;
      if (typeof format === "string" && format.startsWith("f")) {
        return (parameter * (unit ? 100 : 1)).toFixed(Number(format.slice(1))) + unit;
      }
      return bareParameters ? String(parameter) + unit : placeholder;
    });
  return /#\d/u.test(resolved) ? "" : resolved;
}
