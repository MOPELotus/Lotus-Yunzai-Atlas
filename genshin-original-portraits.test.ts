import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("原神同版缺立绘进入原源补齐，全部失败时不发布，其他分类跳过补齐", async () => {
  const base = await mkdtemp(join(tmpdir(), "lotus-atlas-portrait-maintenance-"));
  try {
    const root = join(base, "atlas");
    const data = join(root, "snapshots/1/data");
    const backend = join(base, "atlas-download/backend");
    const bin = join(base, "bin");
    const version = "7.2";
    const id = "10000136";
    const name = "米提亚";
    const row = { icon: "UI_AvatarIcon_Mitya" };
    const page = (key: string, target: string, title: string) => ({
      id: key, version, sampled: false, recordCount: 1, totalRecordCount: 1,
      records: { [target]: { id: target, name: title, hasDetail: true, path: `items/${key}.json` } },
    });
    await Promise.all([mkdir(join(data, "items"), { recursive: true }),
      mkdir(join(backend, ".git"), { recursive: true }), mkdir(bin)]);
    await Promise.all([
      symlink("snapshots/1/data", join(root, "current")),
      writeFile(join(data, "map.json"), JSON.stringify({ games: { gi: { locales: { zh: { pages: {
        character: page("character", id, name), weapon: page("weapon", "1", "武器"),
      } } } } } })),
      writeFile(join(data, "items/character.json"), JSON.stringify({
        meta: { gameId: "gi", pageId: "character", locale: "zh", version, recordId: id, name, hasDetail: true,
          images: [{ fieldPath: "icon", status: "downloaded", placeholder: false, localPath: "gallery/gi/portrait.webp" }] },
        content: { list: row, detail: row },
      })),
      writeFile(join(data, "items/weapon.json"), JSON.stringify({
        meta: { gameId: "gi", pageId: "weapon", locale: "zh", version, recordId: "1", name: "武器", hasDetail: true },
        content: { list: {}, detail: {} },
      })),
      writeFile(join(bin, "git"), `#!/bin/sh
case " $* " in
  *' rev-parse '*) printf '%s\\n' 0496f9cf725d815b89f118b30f681cae82ad2f4e ;;
  *' status '*) exit 0 ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 }),
      writeFile(join(bin, "corepack"), "#!/bin/sh\nexit 0\n", { mode: 0o700 }),
      writeFile(join(bin, "node"), "#!/bin/sh\nexit 1\n", { mode: 0o700 }),
    ]);
    await cp(data, join(backend, "data"), { recursive: true });
    await writeFile(join(backend, "data/gallery-index.json"), '{"images":[]}');
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
    const child = Bun.spawn([process.execPath, "-e", script, root], { env: { PATH: bin }, stdout: "pipe", stderr: "pipe" });
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
