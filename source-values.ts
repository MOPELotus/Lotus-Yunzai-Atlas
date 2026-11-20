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

export const branchAndBladeIcon = "SuitBranch&BladeSong";

export function isAtlasGalleryPath(path: string | undefined, game: string): path is string {
  if (!path?.startsWith(`gallery/${game}/`) || !/\.(?:png|webp|jpe?g)$/iu.test(path)) return false;
  if (game === "zzz" && path === `gallery/zzz/${branchAndBladeIcon}.webp`) return true;
  return path.split("/").every((part) => /^[\p{L}\p{N}][\p{L}\p{N}_. -]*$/u.test(part));
}

export function galleryArtwork(images: unknown, game: string) {
  const fields = new Map<string, string>();
  for (const image of Array.isArray(images) ? images : Object.values(object(images))) {
    const { status, placeholder, localPath, fieldPath } = object(image);
    const path = label(localPath);
    const field = label(fieldPath);
    if (status === "downloaded" && placeholder === false && !fields.has(field) && field && isAtlasGalleryPath(path, game)) {
      fields.set(field, path);
    }
  }
  // A generic Atlas card uses the first downloaded image in source order.
  return (...keys: string[]) => keys.length ? keys.map((key) => fields.get(key)).find((path) => path !== undefined)
    : fields.values().next().value;
}

export function effectText(
  value: unknown, parameters?: readonly unknown[], bareParameters = false, truncateInteger = false,
): string {
  const text = label(value).replace(/<\/?(?:unbreak|color(?:=[^>]*)?|u)>/giu, "").replace(/\\n/gu, "\n");
  const resolved = text.replace(/#(\d+)(?:\[(i|m|f[0-4])\])?(%?)(?![\d%\[])/gu,
    (placeholder, index, format, unit) => {
      const parameter = parameters?.[Number(index) - 1];
      if (typeof parameter !== "number" || !Number.isFinite(parameter)) return placeholder;
      // A bare percentage is stored in percentage points, a typed one as a ratio.
      if (format === "i") {
        const value = parameter * (unit ? 100 : 1);
        if (!truncateInteger) return value.toFixed(0) + unit;
        // Neutralize binary rounding noise in ratios such as 0.29 before truncating.
        const tolerance = Number.EPSILON * Math.max(1, Math.abs(value));
        return Math.trunc(value + Math.sign(value) * tolerance) + unit;
      }
      if (typeof format === "string" && format.startsWith("f")) {
        return (parameter * (unit ? 100 : 1)).toFixed(Number(format.slice(1))) + unit;
      }
      return bareParameters ? String(parameter) + unit : placeholder;
    });
  return /#\d/u.test(resolved) ? "" : resolved;
}
