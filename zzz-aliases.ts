import { dirname, join } from "node:path";

type RedisReader = { hGetAll(key: string): Promise<Record<string, string>> };
type Alias = { readonly role: string; readonly label: string; readonly id?: string };
const redisKey = "lotus-yunzai:zzz-role-aliases";
const deleted = "-";
const compareAndSet = `
local current = redis.call('HGET', KEYS[1], ARGV[1])
if (current or '') ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1
`;

export const zzzRoleName = (name: string) => name.normalize("NFKC").trim().toLowerCase();

export function zzzAliasKey(value: string) {
  const key = zzzRoleName(value);
  if (key.isWellFormed() && /^[\p{L}\p{N}._·・-]{1,48}$/u.test(key) && /\p{L}/u.test(key)) return key;
}

function safeTitle(value: unknown): value is string {
  return typeof value === "string" && value.isWellFormed() && value.length > 0 && value.length <= 80 &&
    !/[\p{Cc}\p{Cf}]/u.test(value);
}

async function readLegacy(resources: string | undefined): Promise<Record<string, unknown>> {
  const paths: (string | URL)[] = [
    ...(resources ? [join(dirname(resources), "config/alias.yaml"), join(dirname(resources), "defSet/alias.yaml"), join(resources, "alias.yaml")] : []),
    new URL("../../resources/builtin/games/zzz/alias.yaml", import.meta.url),
  ];
  for (const path of paths) {
    const file = Bun.file(path);
    if (!await file.exists()) continue;
    if (file.size > 512 * 1024) throw new Error("绝区零别名配置过大。");
    const parsed: unknown = Bun.YAML.parse(await file.text());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  }
  return {};
}

export function zzzRoleAlias(aliases: Readonly<Record<string, unknown>> | undefined, query: string) {
  const key = zzzRoleName(query);
  const canonical = Object.keys(aliases ?? {}).filter(title => zzzRoleName(title) === key);
  if (canonical.length) return canonical.length === 1 ? canonical[0] : undefined;
  const matches = Object.entries(aliases ?? {}).filter(([, list]) =>
    Array.isArray(list) && list.some(item => typeof item === "string" && zzzRoleName(item) === key));
  if (matches.length === 1) return matches[0]?.[0];
}

export async function readZzzAliasRegistry(resources: string | undefined, redis?: RedisReader) {
  const [legacy, overrides] = await Promise.all([readLegacy(resources), redis?.hGetAll(redisKey).catch(() => undefined)]);
  const aliases = new Map<string, Alias[]>();
  const canonical = new Set<string>();
  const groups = new Map<string, string[]>();
  for (const [role, entries] of Object.entries(legacy)) {
    if (!safeTitle(role) || !Array.isArray(entries)) continue;
    canonical.add(zzzRoleName(role));
    groups.set(role, []);
    for (const item of entries) {
      if (!safeTitle(item)) continue;
      const key = zzzRoleName(item);
      const found = aliases.get(key) ?? [];
      if (!found.some(alias => alias.role === role)) aliases.set(key, [...found, { role, label: item }]);
    }
  }
  for (const [key, encoded] of Object.entries(overrides ?? {})) {
    if (zzzAliasKey(key) !== key || canonical.has(key)) continue;
    if (encoded === deleted) {
      aliases.delete(key);
      continue;
    }
    try {
      const { role, label, id } = JSON.parse(encoded) as Partial<Alias>;
      if (safeTitle(role) && typeof label === "string" && zzzAliasKey(label) === key &&
          typeof id === "string" && /^[1-9]\d{0,5}$/u.test(id)) aliases.set(key, [{ role, label, id }]);
    } catch {
      continue;
    }
  }
  for (const entries of aliases.values()) {
    for (const { role, label } of entries) {
      const list = groups.get(role) ?? [];
      list.push(label);
      groups.set(role, list);
    }
  }
  return { groups: Object.fromEntries(groups), aliases, canonical, overrides };
}

export async function updateZzzRoleAlias(redis: { eval(script: string, args: { keys: string[]; arguments: string[] }): Promise<unknown> },
  key: string, expected: string | undefined, entry?: Alias) {
  if (zzzAliasKey(key) !== key) return false;
  return await redis.eval(compareAndSet, { keys: [redisKey], arguments: [key, expected ?? "", entry ? JSON.stringify(entry) : deleted] }) === 1;
}
