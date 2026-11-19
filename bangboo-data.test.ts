import { expect, test } from "bun:test";
import { normalizeBangbooDetails } from "./bangboo-data.ts";

const bangboo = { id: "54001", name: "鲨牙布", version: "3.4.4+20539349" };

test("preserves legacy Bangboo descriptions, base stats and per-level skill values", () => {
  const level = {
    name: "旱地猎鲨",
    desc: "<color=#FFFFFF>[主动技]</color>\\n设置陷阱。",
    property: ["伤害倍率", "冷却时间", "缺失参数"],
    param: "{{Skill:5400101, Prop:1001}/3}+{{Skill:5400101, Prop:1001}*2/3}|12秒|{Skill:5400101, Prop:1003}",
  };
  const artwork = "gallery/zzz/BangbooGarageRole07.webp";
  const details = normalizeBangbooDetails(bangboo, { detail: {
    id: 54001,
    desc: "出没于远洋及生鲜超市海产区。",
    stats: { hp_max: 1000, attack: 65, defence: 30, break_stun: 9.5, crit: 500, crit_damage: 5000, endurance: 0 },
    skill: {
      a: { level: { 2: { ...level, level: 3 }, 1: level } },
      b: { level: [{ name: "寒流涌动", property: ["积蓄值提升"], param: "100%" }] },
      c: { level: [{ name: "追猎不休", desc: "召唤追踪陷阱。" }] },
    },
    skill_prop: { 5400101: { 1001: { main: 38400, growth: 3840, format: "%" } } },
  } }, [{ fieldPath: "detail.icon", localPath: artwork, status: "downloaded", placeholder: false }]);

  expect(details).toEqual({
    name: bangboo.name, version: bangboo.version, artwork,
    description: "出没于远洋及生鲜超市海产区。",
    stats: [
      { label: "生命值", value: "1,000" },
      { label: "攻击力", value: "65" },
      { label: "防御力", value: "30" },
      { label: "冲击力", value: "9.5" },
      { label: "暴击率", value: "5%" },
      { label: "暴击伤害", value: "50%" },
      { label: "耐久", value: "0" },
    ],
    skills: [
      {
        name: "旱地猎鲨", type: "主动技", description: "[主动技]\n设置陷阱。",
        artwork: "gallery/zzz/IconRoleSkillKeySpecial.webp", levels: [1, 3],
        rows: [{ label: "伤害倍率", values: ["384%", "460.8%"] }, { label: "冷却时间", values: ["12秒", "12秒"] }],
      },
      {
        name: "寒流涌动", type: "额外能力", description: "",
        artwork: "gallery/zzz/Icon_CoreSkill.webp", levels: [1], rows: [{ label: "积蓄值提升", values: ["100%"] }],
      },
      {
        name: "追猎不休", type: "邦布连携技", description: "召唤追踪陷阱。",
        artwork: "gallery/zzz/Icon_UltimateReady.webp", levels: [1], rows: [],
      },
    ],
  });
});

test("rejects another record and skips unusable artwork or malformed skill data", () => {
  expect(normalizeBangbooDetails(bangboo, { detail: { id: 54002 } })).toBeUndefined();
  expect(normalizeBangbooDetails(bangboo, { detail: { id: [54001] } })).toBeUndefined();
  const details = normalizeBangbooDetails(bangboo, {
    list: { desc: "简介" },
    detail: { id: 54001, skill: { a: { level: { 1: null } } }, stats: { hp_max: false } },
  }, [
    { fieldPath: "icon", localPath: "gallery/zzz/../asset.webp", status: "downloaded", placeholder: false },
    { fieldPath: "detail.icon", localPath: "https://example.com/master.webp", status: "downloaded", placeholder: false },
  ]);
  expect(details).toEqual({
    name: bangboo.name, version: bangboo.version, description: "简介", artwork: undefined, stats: [], skills: [],
  });
});

test("retains an explicitly present legacy skill slot with no published levels", () => {
  const details = normalizeBangbooDetails(bangboo, { detail: { id: 54001, skill: { c: { level: {} } } } });
  expect(details?.skills).toEqual([{
    type: "邦布连携技", name: "邦布连携技", description: "", levels: [], rows: [],
    artwork: "gallery/zzz/Icon_UltimateReady.webp",
  }]);
});
