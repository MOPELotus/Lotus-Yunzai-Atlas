import type { RoleDetails, RoleRank } from "./role-data.ts";
import { label, object } from "./source-values.ts";

type RoleIdentity = Pick<RoleDetails, "game" | "id" | "overview">;
const characterRoot = new URL("../../resources/builtin/games/miao/meta-sr/character/", import.meta.url);
const sameName = (name: string) => name.normalize("NFKC").replace(/[·•・]/gu, "·");

/** Extra eidolons are static encyclopedia entries, independent of a player's six ordinary eidolons. */
export function normalizeExtraEidolons(role: RoleIdentity, metadata: unknown): readonly RoleRank[] {
  const record = object(metadata);
  if (role.game !== "hsr" || String(record.id) !== role.id ||
      sameName(label(record.name)) !== sameName(role.overview.name)) return [];
  return Object.entries(object(record.exCons)).flatMap(([key, value]) => {
    const rank = Number(key);
    const entry = object(value);
    const name = label(entry.name);
    const description = label(entry.desc).replace(/<br\s*\/?\s*>/giu, "\n")
      .replace(/<\/?(?:nobr|b|i|strong|span(?:\s[^>]*)?)>/giu, "").trim();
    return Number.isSafeInteger(rank) && rank > 0 && name && description ? [{ rank, name, description }] : [];
  }).sort((a, b) => a.rank - b.rank);
}

export async function readBuiltinExtraEidolons(role: RoleIdentity): Promise<{
  readonly entries: readonly RoleRank[];
  readonly icon?: Buffer;
}> {
  if (role.game !== "hsr" || !/^[1-9]\d*$/u.test(role.id)) return { entries: [] };
  try {
    const roster = object(await Bun.file(new URL("data.json", characterRoot)).json());
    const name = label(object(roster[role.id]).name);
    if (!name || /[/\\\p{Cc}\p{Cf}]/u.test(name) || name === "." || name === ".." ||
        sameName(name) !== sameName(role.overview.name)) return { entries: [] };
    const directory = new URL(encodeURIComponent(name) + "/", characterRoot);
    const entries = normalizeExtraEidolons(role, await Bun.file(new URL("data.json", directory)).json());
    if (!entries.length) return { entries };
    const icon = await Bun.file(new URL("imgs/cons-ex.webp", directory)).bytes().then(Buffer.from).catch(() => undefined);
    return { entries, icon };
  } catch {
    // An absent optional metadata supplement must not hide a valid downloaded encyclopedia.
    return { entries: [] };
  }
}
