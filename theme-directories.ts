import { fileURLToPath } from "node:url";

export function atlasThemeDirectories(moduleUrl: string | URL, override?: string): readonly string[] {
  const configured = override?.trim();
  if (configured) return [configured];
  return [
    fileURLToPath(new URL("../../data/atlas/theme", moduleUrl)),
    fileURLToPath(new URL("./assets/miao-theme", moduleUrl)),
  ];
}
