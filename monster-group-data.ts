import { object } from "./source-values.ts";

const groupPages = ["EliteGroup", "HardLevelGroup", "InfiniteEliteGroup"] as const;
type GroupPage = typeof groupPages[number];

export function isMonsterGroupPage(pageId: string): pageId is GroupPage {
  return (groupPages as readonly string[]).includes(pageId);
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function ratio(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Group membership uses the raw IDs. The exporter assigns file IDs from array positions. */
export function monsterGroupKey(pageId: GroupPage, value: unknown): string | undefined {
  const row = object(value);
  const { AttackRatio, DefenceRatio, HPRatio, SpeedRatio, StanceRatio } = row;
  if (![AttackRatio, HPRatio, SpeedRatio, StanceRatio].every(ratio)) return;
  if (pageId !== "HardLevelGroup") {
    if (!positiveId(row.EliteGroup) || !ratio(DefenceRatio)) return;
    return String(row.EliteGroup);
  }

  const { HardLevelGroup, Level, CombatPowerList, StatusProbability, StatusResistance } = row;
  if (!positiveId(HardLevelGroup) || !positiveId(Level) ||
      (DefenceRatio !== undefined && !ratio(DefenceRatio)) ||
      ![StatusProbability, StatusResistance].every(value => value === undefined || ratio(value)) ||
      !Array.isArray(CombatPowerList) || CombatPowerList.length !== 4 ||
      !CombatPowerList.every(value => Number.isSafeInteger(value) && value >= 0)) return;
  return `${HardLevelGroup}/${Level}`;
}
