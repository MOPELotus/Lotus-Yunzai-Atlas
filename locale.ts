import { object } from "./source-values.ts";

export const atlasLocales = {
  zh: { folder: "简体中文", label: "Chinese" },
  cht: { folder: "繁體中文", label: "Traditional Chinese" },
  en: { folder: "English", label: "English" },
  ja: { folder: "日本語", label: "Japanese" },
  ko: { folder: "한국어", label: "Korean" },
} as const;

export type AtlasLocale = keyof typeof atlasLocales;
export const defaultAtlasLocale: AtlasLocale = "zh";

export function parseAtlasLocale(value: unknown): AtlasLocale | undefined {
  if (typeof value !== "string") return;
  const name = value.trim();
  return (Object.keys(atlasLocales) as AtlasLocale[]).find(id => name === id || name === atlasLocales[id].folder);
}

export function atlasLocaleBlock(game: unknown, locale: AtlasLocale) {
  const locales = object(object(game).locales);
  return object(locales[locale] ?? locales[atlasLocales[locale].folder] ??
    Object.values(locales).find(value => object(object(value).locale).folder === atlasLocales[locale].folder));
}

export function atlasPageKey({ game, pageId, locale = defaultAtlasLocale }: {
  readonly game: string;
  readonly pageId: string;
  readonly locale?: AtlasLocale;
}) {
  return locale === defaultAtlasLocale ? `${game}/${pageId}` : `${game}/${locale}/${pageId}`;
}
