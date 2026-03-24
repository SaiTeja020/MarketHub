// src/scraper/scrapeProduct.ts
import { runScraper } from "./runScraper";

export type RawScrape = {
  // scrapers may return different keys; keep everything optional and allow null
  product_id?: string | null;
  id?: string | null;
  title?: string | null;
  current_price?: number | null;
  currency?: string | null;
  source?: string | null;
  url?: string | null;
  image_url?: string | null;
  imageUrl?: string | null; // some scrapers might use camelCase
  scraped_at?: string | null;
  // allow arbitrary extra fields
  [k: string]: any;
};

export type ScrapeResult = {
  product_id: string | null;
  id: string;
  title: string | null;
  current_price: number | null;
  currency: string | null;
  source: string | null;
  url: string | null;
  image_url: string | null;
  scraped_at: string;
  error?: string | null;
};

const DEFAULT_RETRIES = 1;
const DEFAULT_DELAY_MS = 500;

function delay(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * scrapeProduct - wrapper that calls runScraper and normalizes result
 * @param taskId - tracing id we will use as fallback for id/product_id
 * @param url - product url
 * @param retries - number of retries on transient errors
 */
export async function scrapeProduct(
  taskId: string,
  url: string,
  retries = DEFAULT_RETRIES
): Promise<ScrapeResult> {
  let attempt = 0;

  while (attempt <= retries) {
    attempt++;
    try {
      const raw: RawScrape = (await runScraper(url)) as RawScrape;

      // Normalize product id / id
      const productId: string | null =
        (raw.product_id ?? raw.id ?? null) as string | null;

      // normalized id (must be a non-empty string for storage, fallback to taskId)
      const id: string = (productId ?? taskId).toString();

      // normalize image url (support both snake_case and camelCase)
      const imageUrl: string | null =
        (raw.image_url ?? raw.imageUrl ?? null) as string | null;

      const scrapedAt = (raw.scraped_at ?? new Date().toISOString()) as string;

      const normalized: ScrapeResult = {
        product_id: productId,
        id,
        title: (raw.title ?? null) as string | null,
        current_price:
          typeof raw.current_price === "number" ? raw.current_price : null,
        currency: (raw.currency ?? null) as string | null,
        source: (raw.source ?? null) as string | null,
        url: (raw.url ?? url ?? null) as string | null,
        image_url: imageUrl,
        scraped_at: scrapedAt,
        error: null,
      };

      return normalized;
    } catch (err: any) {
      const errMsg = err?.message ?? String(err);
      if (attempt > retries) {
        return {
          product_id: null,
          id: taskId,
          title: null,
          current_price: null,
          currency: null,
          source: null,
          url,
          image_url: null,
          scraped_at: new Date().toISOString(),
          error: `scrape_failed: ${errMsg}`,
        };
      }
      
      // Force restart the browser if a Playwright action failed
      try {
        const { restartBrowser } = await import("./browserPool");
        await restartBrowser();
      } catch (poolErr) {}

      // exponential-ish backoff
      await delay(DEFAULT_DELAY_MS * attempt);
    }
  }

  // should not hit
  return {
    product_id: null,
    id: taskId,
    title: null,
    current_price: null,
    currency: null,
    source: null,
    url,
    image_url: null,
    scraped_at: new Date().toISOString(),
    error: "unknown_error",
  };
}
