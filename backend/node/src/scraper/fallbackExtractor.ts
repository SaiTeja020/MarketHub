// src/scraper/fallbackExtractor.ts
import type { Page } from 'playwright';

let cheerio: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  cheerio = require('cheerio');
} catch (e) {
  cheerio = null;
}

export type ParseResult = {
  title?: string;
  price?: string;
  image?: string;
};

/**
 * Deterministic parse: accepts HTML string or Playwright Page
 * Returns a Promise that resolves to ParseResult
 */
export async function deterministicParse(
  input: string | Page,
  opts: { url?: string } = {}
): Promise<ParseResult> {
  let html: string | undefined;

  // If input is a Playwright Page, try to get content
  if (typeof (input as Page).content === 'function') {
    try {
      const page = input as Page;
      html = await page.content();
      if (!html || html.length < 50) {
        // small wait + retry
        await page.waitForTimeout(500);
        html = await page.content();
      }
    } catch (_err) {
      html = undefined;
    }
  } else if (typeof input === 'string') {
    html = input;
  }

  if (!html || typeof html !== 'string') {
    const err = new Error(`deterministicParse: no HTML available (html length: ${String(html?.length)})`);
    (err as any).url = opts.url ?? 'unknown';
    throw err;
  }

  let $: any = null;
  if (cheerio) {
    try {
      $ = cheerio.load(html);
    } catch (e) {
      $ = null;
    }
  }

  const minimalSelector = (selectorRegex: RegExp): string | undefined => {
    const m = selectorRegex.exec(html as string);
    return m && m[1] ? m[1].trim() : undefined;
  };

  try {
    let title: string | undefined;
    let price: string | undefined;
    let image: string | undefined;

    if ($) {
      title =
        ($('meta[property="og:title"]').attr('content') as string | undefined) ||
        ($('title').first().text() as string | undefined) ||
        ($('#productTitle').text() as string | undefined) ||
        ($('h1').first().text() as string | undefined);

      price =
        ($('[id^="priceblock_"]').first().text() as string | undefined) ||
        ($('[data-automation="price"]').first().text() as string | undefined) ||
        ($('[class*="price"]').first().text() as string | undefined);

      image =
        ($('meta[property="og:image"]').attr('content') as string | undefined) ||
        ($('#imgTagWrapperId img').attr('src') as string | undefined) ||
        ($('img#landingImage').attr('src') as string | undefined) ||
        ($('img').first().attr('src') as string | undefined);
    } else {
      title =
        minimalSelector(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
        minimalSelector(/<title[^>]*>([^<]+)<\/title>/i) ||
        minimalSelector(/<h1[^>]*>([^<]+)<\/h1>/i);

      price =
        minimalSelector(/id=["']priceblock_[^"']+["'][^>]*>([^<]+)</i) ||
        minimalSelector(/"price"\s*:\s*"([^"]+)"/i) ||
        minimalSelector(/₹\s*[\d,]+(?:\.\d+)?/i);

      image =
        minimalSelector(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
        minimalSelector(/<img[^>]*id=["']landingImage["'][^>]*src=["']([^"']+)["']/i) ||
        minimalSelector(/<img[^>]*src=["']([^"']+)["']/i);
    }

    title = title && title.length ? title : undefined;
    price = price && price.length ? price : undefined;
    image = image && image.length ? image : undefined;

    return { title, price, image };
  } catch (err) {
    const wrapped = new Error(`deterministicParse: parser error: ${(err as Error).message || err}`);
    (wrapped as any).htmlSnippet = (html as string).slice(0, 300);
    (wrapped as any).url = opts.url ?? 'unknown';
    throw wrapped;
  }
}
