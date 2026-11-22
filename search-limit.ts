export const defaultAtlasSearchLimit = 8;

export function parseAtlasSearchLimit(value: unknown): number | undefined {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof number === "number" && Number.isSafeInteger(number) && number > 0) return number;
}
