import { label, object } from "./source-values.ts";

export const challengeRecordId = /^[1-9]\d{0,9}$/u;
export const challengeEncounterIcon = /^Assets\/NapResources\/UI\/Sprite\/A1DynamicLoad\/IconBossGeneral\/UnPacker\/(IconMonster[A-Za-z0-9_-]{1,110})\.png$/u;
export const challengeEnemyIcon = /^UI\/Sprite\/A1DynamicLoad\/BossCard\/UnPacker\/BossCardLv0[1-4]\/(Monster[A-Za-z0-9_-]{1,110})\.png$/u;

export function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function validAffinity(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.values(object(value)).every((affinity) => Boolean(label(affinity)));
}
