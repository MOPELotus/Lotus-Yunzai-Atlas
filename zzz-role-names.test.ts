import { expect, test } from "bun:test";
import { findCharacters, findTraditionalEntries } from "./catalog.ts";
import { normalizeRoleDetails } from "./role-data.ts";
import { parseEquipmentShortcut, parseRoleShortcut } from "./traditional.ts";
import { verifiedZzzRoleNames } from "./zzz-role-names.ts";

test("已核对的绝区零角色全名、旧写法和原短名均路由到同一角色", () => {
  const entries = verifiedZzzRoleNames.map(([id, name]) => ({
    id, name, game: "zzz" as const, version: "3.3", rarity: "", path: `items/${id}.json`,
  }));
  const catalog = { pages: [{ game: "zzz", kind: "character", name: "角色", version: "3.3", sampled: false, entries }] as const, stale: false };
  const aliases = new Set<string>();
  expect(new Set(entries.map(({ id }) => id)).size).toBe(entries.length);
  for (const [index, [id, shortName, fullName, alternateNames = []]] of verifiedZzzRoleNames.entries()) {
    const entry = entries[index]!;
    expect(findCharacters(catalog, shortName, "zzz")).toEqual([entry]);
    for (const query of new Set([fullName, ...alternateNames])) {
      expect(aliases.has(query)).toBe(false);
      aliases.add(query);
      expect(parseEquipmentShortcut(`%${query}图鉴`)).toEqual({ game: "zzz", query });
      expect(parseRoleShortcut(`%${query}影画`)).toEqual({ game: "zzz", query });
      expect(findTraditionalEntries(catalog, query, "zzz", "name").map(({ entry }) => entry.id)).toEqual([id]);
      expect(findTraditionalEntries(catalog, query, "zzz", "equipment")).toEqual([]);
    }
    expect(normalizeRoleDetails(entry, { detail: { partner_info: { full_name: fullName } } }, "")?.overview.name).toBe(fullName);
    expect(normalizeRoleDetails(entry, { detail: { partner_info: { full_name: "另一名" } } }, "")?.overview.name).toBe(shortName);
  }
  for (const unresolved of ["简·杜", "浅羽悠真", "露西亚娜·德·蒙特夫"]) {
    expect(findTraditionalEntries(catalog, unresolved, "zzz", "name")).toEqual([]);
  }
});
