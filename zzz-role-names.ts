type VerifiedRoleName = readonly [id: string, name: string, fullName: string, alternateNames?: readonly string[]];

// Each entry matches the published character ID, the old command result, and the old card title.
export const verifiedZzzRoleNames: readonly VerifiedRoleName[] = [
  ["1011", "安比", "安比·德玛拉", ["安比德玛拉"]],
  ["1021", "猫又", "猫宫又奈", ["猫宫 又奈"]],
  ["1031", "妮可", "妮可·德玛拉", ["妮可德玛拉"]],
  ["1051", "伊德海莉", "伊德海莉·墨菲"],
  ["1061", "可琳", "可琳·威克斯"],
  ["1071", "凯撒", "凯撒·金"],
  ["1081", "比利", "比利·奇德"],
  ["1091", "雅", "星见雅"],
  ["1101", "珂蕾妲", "珂蕾妲·贝洛伯格"],
  ["1111", "安东", "安东·伊万诺夫"],
  ["1121", "本", "本·比格"],
  ["1141", "莱卡恩", "冯·莱卡恩"],
  ["1171", "柏妮思", "柏妮思·怀特"],
  ["1181", "格莉丝", "格莉丝·霍华德"],
  ["1191", "艾莲", "艾莲·乔"],
  ["1211", "丽娜", "亚历山德丽娜·莎芭丝缇安"],
  ["1221", "柳", "月城柳"],
  ["1271", "赛斯", "赛斯·洛威尔"],
  ["1291", "雨果", "雨果·维拉德"],
  ["1301", "奥菲丝&「鬼火」", "奥菲丝·马格努森&「鬼火」"],
  ["1321", "伊芙琳", "伊芙琳 · 舒瓦利耶", ["伊芙琳·舒瓦利耶"]],
  ["1331", "薇薇安", "薇薇安·班希"],
  ["1351", "波可娜", "波可娜·费雷尼"],
  ["1381", "零号·安比", "零号·安比", ["零号安比"]],
  ["1401", "爱丽丝", "爱丽丝·泰姆菲尔德"],
  ["1411", "柚叶", "浮波柚叶"],
  ["1441", "真斗", "狛野真斗"],
  ["1451", "卢西娅", "卢西娅·艾洛温"],
  ["1561", "维琳娜", "维琳娜·艾嘉德"],
  ["1571", "诺姆", "诺姆·霍洛维尔"],
  ["1581", "蕾米埃尔", "蕾米埃尔·丹"],
  ["1591", "希格莉德", "希格莉德·德拉叙尔"],
  ["1611", "克拉蕾", "克拉蕾·弗林特"],
  ["1621", "洛克茜", "洛克茜·伊芙莉塔·普莱斯"],
  ["1631", "赛维里安", "赛维里安·洛威尔"],
  ["1641", "菲欧妮", "菲欧妮·蕾法爱菈"],
];

export const zzzFullNames = new Map(verifiedZzzRoleNames.map(([id, name, fullName]) => [id, { name, fullName }]));
export const zzzCharacterAliases = new Map(verifiedZzzRoleNames.flatMap(([id, name, fullName, alternateNames = []]) =>
  [fullName, ...alternateNames].filter((alias) => alias !== name).map((alias) => [alias, { id, name }] as const)));
