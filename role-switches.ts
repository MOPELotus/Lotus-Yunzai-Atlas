export const atlasRoleFields = ["role_wiki", "role_talent", "role_photo"] as const;
export type AtlasRoleField = typeof atlasRoleFields[number];
export type AtlasRoleSettings = Record<AtlasRoleField, boolean>;

export function readAtlasRoleSettings(value: unknown): AtlasRoleSettings {
  const atlas = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  return {
    role_wiki: atlas?.role_wiki !== false,
    role_talent: atlas?.role_talent !== false,
    role_photo: atlas?.role_photo !== false,
  };
}
