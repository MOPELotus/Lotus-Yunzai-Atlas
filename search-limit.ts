export const defaultAtlasSearchLimit = 8;
export const maxAtlasSearchLimit = 50;

export function parseAtlasSearchLimit(value: unknown): number | undefined {
  const number = typeof value === "string" && /^\d+$/u.test(value.trim()) ? Number(value) : value;
  if (typeof number === "number" && Number.isSafeInteger(number) && number > 0 && number <= maxAtlasSearchLimit) return number;
}
