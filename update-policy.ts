import { atlasSourceSelections, type SourceSelection } from "./refresh-source.ts";
import { object } from "./source-values.ts";

export type AtlasScheduleKind = "version" | "challenge";

interface AtlasSchedulePolicy {
  readonly selections: readonly SourceSelection[];
  readonly cron?: string;
  readonly issue?: string;
}

const defaults: Readonly<Record<AtlasScheduleKind, string>> = {
  version: "0 0 */6 * * ? *",
  challenge: "0 15 */2 * * ? *",
};

const cronBounds = [[0, 59], [0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
const months = "JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split(" ");
const weekdays = "SUN MON TUE WED THU FRI SAT".split(" ");

function validCronField(field: string, index: number): boolean {
  const bounds = cronBounds[index];
  if (!bounds) return false;
  const [minimum, maximum] = bounds;
  const names = index === 4 ? months : index === 5 ? weekdays : [];
  const numeric = field.replace(/[a-z]+/giu, (name) => {
    const value = names.indexOf(name.toUpperCase());
    return value < 0 ? name : String(value + minimum);
  });
  return numeric.split(",").every((part) => {
    const value = /^(\*|\d+)(?:-(\d+))?(?:\/([1-9]\d*))?$/u.exec(part);
    if (!value) return false;
    const [, start, end] = value;
    if (start === "*") return end === undefined;
    const lower = Number(start);
    const upper = Number(end ?? start);
    return minimum <= lower && lower <= upper && upper <= maximum;
  });
}

function cron(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const fields = value.trim().split(/\s+/u);
  if (fields.length === 7) {
    // Quartz numeric weekdays use a different base, and constrained years have no six-field equivalent.
    const hasDayOfMonthPlaceholder = fields[3] === "?";
    const hasWeekdayPlaceholder = fields[5] === "?";
    if (fields[6] !== "*" || /\d/u.test(fields[5] ?? "") || hasDayOfMonthPlaceholder === hasWeekdayPlaceholder) return;
    fields.pop();
  }
  if (fields.length === 5) fields.unshift("0");
  if (fields.length !== 6) return;
  for (const index of [3, 5]) if (fields[index] === "?") fields[index] = "*";
  if (!fields.every(validCronField)) return;
  return fields.join(" ");
}

const localeIds = new Map([
  ["zh", "zh"], ["cn", "zh"], ["zh-cn", "zh"], ["zh-hans", "zh"], ["zh_hans", "zh"],
  ["en", "en"], ["ja", "ja"], ["jp", "ja"], ["ko", "ko"], ["kr", "ko"],
]);

function configuredScope(value: unknown, selections: readonly SourceSelection[]): readonly SourceSelection[] | undefined {
  if (value === undefined) return selections;
  if (!Array.isArray(value) || !value.every((argument): argument is string => typeof argument === "string")) return;
  const args: readonly string[] = value[0] === "src/scrape.mjs" ? value.slice(1) : value;
  const games = new Set<string>();
  const locales = new Set<string>();
  const pages = new Set<string>();
  for (const iterator = args.values();;) {
    const { value: option, done } = iterator.next();
    if (done) break;
    if (option === "--incremental") continue;
    const match = /^--(game|locales?|pages?|mode)(?:=(.*))?$/u.exec(option);
    if (!match) return;
    const [, key, inline] = match;
    const argument = inline ?? iterator.next().value;
    if (!argument?.trim()) return;
    if (key === "mode") {
      if (argument !== "incremental") return;
    } else if (key === "game") {
      const parts = argument.split(",").map((item) => item.trim()).filter(Boolean);
      if (!parts.length || parts.some((item) => !/^[a-z0-9][a-z0-9_-]*$/u.test(item))) return;
      for (const item of parts) games.add(item);
    } else if (key === "locale" || key === "locales") {
      for (const item of argument.toLowerCase().split(",").map((part) => part.trim()).filter(Boolean)) {
        if (item === "all") continue;
        const locale = localeIds.get(item);
        if (!locale) return;
        locales.add(locale);
      }
    } else {
      for (const segment of argument.split(";")) {
        const match = /^([a-z0-9_-]+)\s*[=:]\s*(.+)$/u.exec(segment.trim());
        if (!match) return;
        const [, game, listing] = match;
        const items = listing!.split(",").map((item) => item.trim()).filter(Boolean);
        if (!items.length || items.some((item) => !/^[a-z][a-z0-9_/-]*$/iu.test(item))) return;
        for (const item of items) pages.add(`${game}/${item}`);
      }
    }
  }
  if (locales.size && !locales.has("zh")) return [];
  return selections.filter((selection) => (!games.size || games.has(selection.split("/")[0]!)) &&
    (!pages.size || pages.has(selection)));
}

export function parseAtlasUpdatePolicy(value: unknown): Readonly<Record<AtlasScheduleKind, AtlasSchedulePolicy>> {
  const atlas = object(value);
  const configured = atlas === value;
  const auto = object(atlas.auto_update);
  const invalidAuto = (atlas.auto_update !== undefined && atlas.auto_update !== auto) ||
    (auto.enable !== undefined && typeof auto.enable !== "boolean");
  const entries = atlasSourceSelections.map(({ selection }) => selection);
  function policy(kind: AtlasScheduleKind, selections: readonly SourceSelection[]): AtlasSchedulePolicy {
    const argsKey = kind === "version" ? "update_args" : "challenge_args";
    const selected = configuredScope(atlas[argsKey], selections);
    if (!selected) return { selections: [], issue: `图鉴 ${argsKey} 含不支持的选项或无效分类范围。` };
    if (value !== undefined && !configured) return { selections: selected, issue: "图鉴配置须为对象。" };
    if (invalidAuto) return { selections: selected, issue: "图鉴 auto_update 配置无效。" };
    if (!configured || auto.enable === false || !selected.length) return { selections: selected };
    const cronKey = kind === "version" ? "check_cron" : "challenge_cron";
    const configuredCron = auto[cronKey];
    const rule = cron(configuredCron === undefined ? defaults[kind] : configuredCron);
    return rule ? { selections: selected, cron: rule }
      : { selections: selected, issue: `图鉴 auto_update.${cronKey} 无效或无法等价转换。` };
  }
  return { version: policy("version", entries), challenge: policy("challenge", ["zzz/boss", "zzz/shiyu"]) };
}
