import { expect, test } from "bun:test";
import { getLanguage, registerLanguage, setLanguage } from "../../packages/i18n/index.ts";
import { parseChallengeShortcut, parseEquipmentShortcut, parseExplicitAtlasChallenge } from "./traditional.ts";
import { characterGalleryName } from "./role-data.ts";
import catalog from "./i18n/zh-CN.json";

async function isolated(name: string) {
  if (Bun.env.LOTUS_I18N_CONTROL_CHILD === name) return false;
  const child = Bun.spawn([process.execPath, "test", "--test-name-pattern", name, import.meta.path], {
    env: { ...process.env, LOTUS_I18N_CONTROL_CHILD: name }, stdout: "pipe", stderr: "pipe",
  });
  const [status, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status !== 0) throw new Error(output + errors);
  return true;
}

test("图鉴命令、挑战期数和主角图库文件名独立于回执语言", async () => {
  if (await isolated('图鉴命令、挑战期数和主角图库文件名独立于回执语言')) return;
  const previous = getLanguage();
  registerLanguage("en", { atlas: Object.fromEntries(Object.keys(catalog.messages).map(key => [key, "translated:" + key])) });
  try {
    setLanguage("en");
    expect(parseEquipmentShortcut("#西风剑图鉴")).toEqual({ game: "gi", query: "西风剑" });
    expect(parseChallengeShortcut("#本期深渊图鉴")?.period).toBe("本期");
    expect(parseExplicitAtlasChallenge("下期深渊", "gi")?.period).toBe("下期");
    const character = { game: "hsr" as const, id: "8001", name: "{NICKNAME}", path: "items/role.json", version: "1", rarity: "五星" };
    expect(characterGalleryName(character, [character])).toBe("穹·毁灭");
  } finally { setLanguage(previous); }
});
