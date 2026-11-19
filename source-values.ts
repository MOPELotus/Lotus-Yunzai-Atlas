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

export function galleryArtwork(images: unknown, game: string) {
  const fields = new Map<string, string>();
  for (const image of Array.isArray(images) ? images : Object.values(object(images))) {
    const { status, placeholder, localPath, fieldPath } = object(image);
    const path = label(localPath);
    const field = label(fieldPath);
    if (status === "downloaded" && placeholder === false && !fields.has(field) && field &&
        path.startsWith(`gallery/${game}/`) &&
        path.split("/").every((part) => /^[\p{L}\p{N}][\p{L}\p{N}_. -]*$/u.test(part)) &&
        /\.(?:webp|png|jpe?g)$/iu.test(path)) fields.set(field, path);
  }
  // A generic Atlas card uses the first downloaded image in source order.
  return (...keys: string[]) => keys.length ? keys.map((key) => fields.get(key)).find((path) => path !== undefined)
    : fields.values().next().value;
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
