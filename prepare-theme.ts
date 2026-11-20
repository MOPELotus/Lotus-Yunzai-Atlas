import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { atlasThemeDirectories } from "./theme-directories.ts";

// Original bytes from Lotus-ReFactor 278a607f564dc9e468e178918268c65ab2bfb51a.
// Restrict recovery to the background set, layout texture and two fonts used by that template.
const assets = [
  ["bg/bg-anemo.webp", 62392, "bcba9f3b53596d40b2e83148d17894ee83d7b7aa07c0519d5f29bc2de7c79ee7"],
  ["bg/bg-cryo.webp", 54930, "893b8c56ded4ffc5cf74e9cd018539ff7fd56c0b1ed98db6742cce46819bd2c6"],
  ["bg/bg-dendro.webp", 64558, "f532a38940e0a34a5f03f58e2b1280d6009e5bf203f4f9a9303fb96abff45a3b"],
  ["bg/bg-electro.webp", 50528, "bacce219687c54479b455324fbefea20545e1458263e690a7a3b3a8d672d6699"],
  ["bg/bg-geo.webp", 58854, "9e681eb0c7d923ae99da5dbbe0856a365efbf0ffc72481930a424863b5543e00"],
  ["bg/bg-hydro.webp", 60760, "5ce05fb55269df615bea9cff080729d46774048fb8e180db4d11b4d7d9ad1ffd"],
  ["bg/bg-pyro.webp", 57284, "48e21bd1ba01db1466a47b3c7f1866d07f1caee82f9493037860b1fd4d5cd44c"],
  ["bg/bg-quantum.webp", 268292, "1c2549c787db19660615d4f87621fb16a41648fc41ba7c9595f049b117806629"],
  ["bg/bg-sr.webp", 322836, "cf98007bc4ba9f56138104319ece79856b4aa6c4cb6ac12271724ac4c482ed5f"],
  ["card-bg.png", 2594, "b7476ae9954e8d884df881dfb398fc701cce1a91ea091ecd895d8449437ff2af"],
  ["fonts/HYWH-65W.ttf", 3155072, "809ab0683bff573c55305c2c723c1692c64d6ecfdb78620b6b99d7a66d662dff"],
  ["fonts/MiSans-VF.ttf", 20000736, "5daf8d5447bfd423cfdec94a0e07c53b205892223ccc6ea21b7b8a37248b44d9"],
] as const;

function paths(directory: string, asset: string): readonly string[] {
  const direct = join(directory, asset);
  return asset === "fonts/MiSans-VF.ttf" ? [direct, join(dirname(directory), asset)] : [direct];
}

async function available(directory: string, asset: string) {
  for (const file of paths(directory, asset)) {
    if (await stat(file).then((entry) => entry.isFile() && entry.size > 0).catch(() => false)) return true;
  }
  return false;
}

async function recover(theme: string, target: string, bytes: Buffer, signal?: AbortSignal) {
  // A symlink supplied by the operator may already serve these files. Avoid writing through it.
  for (const directory of new Set([theme, dirname(target)])) {
    await mkdir(directory, { recursive: true });
    if (!(await lstat(directory)).isDirectory()) return false;
  }
  const stage = await mkdtemp(join(dirname(target), ".atlas-theme-"));
  try {
    const copy = join(stage, basename(target));
    await writeFile(copy, bytes, { mode: 0o600, signal });
    signal?.throwIfAborted();
    await link(copy, target);
    return true;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function prepareAtlasTheme(checkout: URL, options: {
  readonly override?: string; readonly source?: string; readonly signal?: AbortSignal;
} = {}) {
  const { override, source, signal } = options;
  const module = new URL("plugins/atlas/theme-directories.ts", checkout);
  const directories = atlasThemeDirectories(module, override);
  const theme = directories[0]!;
  const donor = source?.trim();
  const sources = override?.trim() ? [] : [...(donor ? [donor] : []), ...directories.slice(1)];
  const copied: string[] = [];
  const missing: string[] = [];
  for (const [asset, size, digest] of assets) {
    signal?.throwIfAborted();
    if (await available(theme, asset)) continue;
    const target = join(theme, asset);
    for (const directory of sources) {
      if (await lstat(target).catch(() => undefined)) break;
      for (const file of paths(directory, asset)) {
        try {
          if (!await stat(file).then((entry) => entry.isFile() && entry.size === size)) continue;
          const bytes = await readFile(file, { signal });
          if (createHash("sha256").update(bytes).digest("hex") !== digest) continue;
          if (await recover(theme, target, bytes, signal)) copied.push(asset);
          break;
        } catch {
          // A concurrent startup, unavailable donor, or read-only directory can be retried next launch.
          signal?.throwIfAborted();
        }
      }
    }
    if (!(await Promise.all(directories.map((directory) => available(directory, asset)))).some(Boolean)) {
      missing.push(asset);
    }
  }
  return { copied, missing };
}
