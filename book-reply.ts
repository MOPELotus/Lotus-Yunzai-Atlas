import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("atlas", messageCatalog.messages);
import { nativeImageRasterScale } from "@lotus-yunzai/skia";
import { batchInlineImagePages } from "@lotus-yunzai/skia/forward-images";
import type { AtlasDelivery, AtlasReply } from "./traditional.ts";

type BookPage = { readonly section: string; readonly png: Uint8Array };

export async function atlasBookReply(name: string, render: (scale: 4 | 2 | 1) => Promise<readonly BookPage[]>,
  delivery?: AtlasDelivery, singleAsForward = false, titleSuffix = $t("book-reply.text_8aed944862")): Promise<AtlasReply | undefined> {
  const budget = delivery?.inlineImageByteLimit;
  const scale = nativeImageRasterScale();
  let pages = await render(scale);
  if (!pages.length) return;
  if (pages.length === 1 && !singleAsForward) return { type: "image", file: pages[0]!.png };
  const bytes = (page: BookPage) => page.png.byteLength;
  if (scale === 4 && budget !== undefined && pages.reduce((total, page) => total + bytes(page), 0) > budget) {
    pages = await render(2);
  }
  const batches = batchInlineImagePages(pages, budget, bytes);
  if (!batches?.length) throw new RangeError($t("book-reply.text_9373fc6746"));

  const sections = [...new Set(pages.map(({ section }) => section))].join(" → ");
  const title = $t("book-reply.text_b34e40b621", { "name": name, "titleSuffix": titleSuffix, "sections": sections, "length": pages.length });
  const image = ({ png }: BookPage) => ({ type: "image" as const, file: png });
  if (batches.length === 1) return { type: "forward", nodes: [title, ...pages.map(image)] };
  return { type: "forward-image-batches", batches: batches.map((group, index) => [
    $t("book-reply.text_11d4132897", { "title": title, "value2": index + 1, "length": batches.length }), ...group.map(image),
  ]) };
}
