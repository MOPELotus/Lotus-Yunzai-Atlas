import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("原神同版缺立绘进入原源补齐，全部失败时不发布，其他分类跳过补齐", async () => {
  const base = await mkdtemp(join(tmpdir(), "lotus-atlas-portrait-maintenance-"));
  try {
    const root = join(base, "atlas");
    const data = join(root, "snapshots/1/data");
    const gallery = join(root, "snapshots/1/gallery/gi");
    const icon = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
    const sha256 = createHash("sha256").update(icon).digest("hex");
    const version = "7.2";
    const id = "10000136";
    const name = "米提亚";
    const row = { icon: "UI_AvatarIcon_Mitya" };
    const page = (key: string, target: string, title: string) => ({
      id: key, version, sampled: false, recordCount: 1, totalRecordCount: 1,
      records: { [target]: { id: target, name: title, hasDetail: true, path: `items/${key}.json` } },
    });
    await Promise.all([mkdir(join(data, "items"), { recursive: true }),
      mkdir(gallery, { recursive: true })]);
    await Promise.all([
      symlink("snapshots/1/data", join(root, "current")),
      writeFile(join(data, "map.json"), JSON.stringify({ games: { gi: { locales: { zh: { pages: {
        character: page("character", id, name), weapon: page("weapon", "1", "武器"),
      } } } } } })),
      writeFile(join(data, "items/character.json"), JSON.stringify({
        meta: { gameId: "gi", pageId: "character", locale: "zh", version, recordId: id, name, hasDetail: true,
          images: [{ fieldPath: "icon", status: "downloaded", placeholder: false, localPath: "gallery/gi/portrait.webp", sha256 }] },
        content: { list: row, detail: row },
      })),
      writeFile(join(data, "items/weapon.json"), JSON.stringify({
        meta: { gameId: "gi", pageId: "weapon", locale: "zh", version, recordId: "1", name: "武器", hasDetail: true },
        content: { list: {}, detail: {} },
      })),
      writeFile(join(gallery, "portrait.webp"), icon),
    ]);
    const script = `
      import { readlink } from "node:fs/promises";
      import { createAtlasMaintenance } from ${JSON.stringify(fileURLToPath(new URL("./maintenance.ts", import.meta.url)))};
      const root = Bun.argv[1];
      const requests = [];
      const forPage = (page) => createAtlasMaintenance(root, {
        updateConfig: { version_channel: "latest", update_args: ["--page", "gi=" + page] },
        manifest: async () => ({ gi: { latest: "7.2", available: ["7.2"] } }),
        request: async (url) => {
          requests.push(url);
          if (url.endsWith("/character.json")) return Response.json({ "10000136": { icon: "UI_AvatarIcon_Mitya" } });
          if (url.endsWith("/UI_Gacha_AvatarImg_Mitya.webp")) return new Response(null, { status: 404 });
          throw new Error("意外请求 " + url);
        },
      }).commands;
      const owner = { atlasMaintenance: true };
      const other = await forPage("weapon")["#更新图鉴"]("", owner);
      const before = requests.length;
      const check = await forPage("character")["#检查图鉴更新"]("", owner);
      const update = await forPage("character")["#更新图鉴"]("", owner);
      console.log(JSON.stringify({ other, before, check, update, requests, current: await readlink(root + "/current") }));
    `;
    const child = Bun.spawn([process.execPath, "-e", script, root], { env: { PATH: "/nonexistent" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const outcome = JSON.parse(stdout);
    expect(outcome.other).toContain("均为目标版本");
    expect(outcome.before).toBe(0);
    expect(outcome.check).toContain("1 张已核原立绘待补齐");
    expect(outcome.update).toContain("未发布可用的新立绘，保留现用快照");
    expect(outcome.current).toBe("snapshots/1/data");
    expect(outcome.requests.map((url: string) => new URL(url).pathname)).toEqual([
      "/gi/7.2/character.json", "/assets/gi/UI_Gacha_AvatarImg_Mitya.webp",
    ]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
