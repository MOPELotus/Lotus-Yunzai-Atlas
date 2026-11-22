import { batchInlineImagePages } from "@lotus-yunzai/skia/forward-images";
import type { AtlasDelivery, AtlasReply } from "./traditional.ts";

type BookPage = { readonly section: string; readonly png: Uint8Array };

export async function atlasBookReply(name: string, render: (scale: 4 | 2) => Promise<readonly BookPage[]>,
  delivery?: AtlasDelivery, singleAsForward = false): Promise<AtlasReply | undefined> {
  const budget = delivery?.inlineImageByteLimit;
  let pages = await render(4);
  if (!pages.length) return;
  if (pages.length === 1 && !singleAsForward) return { type: "image", file: pages[0]!.png };
  const bytes = (page: BookPage) => page.png.byteLength;
  if (budget !== undefined && pages.reduce((total, page) => total + bytes(page), 0) > budget) {
    pages = await render(2);
  }
  const batches = batchInlineImagePages(pages, budget, bytes);
  if (!batches?.length) throw new RangeError("图鉴单页超过当前聊天的图片大小上限。");

  const sections = pages.map(({ section }) => section).join(" → ");
  const title = `${name}完整图鉴\n${sections}\n共 ${pages.length} 页`;
  const image = ({ png }: BookPage) => ({ type: "image" as const, file: png });
  if (batches.length === 1) return { type: "forward", nodes: [title, ...pages.map(image)] };
  return { type: "forward-image-batches", batches: batches.map((group, index) => [
    `${title}（第 ${index + 1}/${batches.length} 段）`, ...group.map(image),
  ]) };
}
