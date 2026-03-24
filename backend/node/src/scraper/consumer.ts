// src/scraper/consumer.ts
// Main RabbitMQ consumer for scraper worker.
// IMPORTANT: this file imports polyfills first to avoid undici/File runtime errors.

import "./polyfills"; // MUST be first import

// src/scraper/consumer.ts (snippet replacing the fallback call)
import fs from 'fs';
import path from 'path';
import { connectQueue, channel } from "../utils/rabbitmq";
import redisClient, { connectRedis } from "../utils/redis";
import { scrapeProduct } from "./scrapeProduct";
import type { ConsumeMessage } from "amqplib";
import { closeBrowser } from "./browserPool";
import { deterministicParse, ParseResult } from './fallbackExtractor';
import type { Page } from "playwright";
// add this import near your other imports at top of file
import { chromium } from 'playwright';

/**
 * fallbackExtract
 * - Attempts to fetch the URL with Playwright, parse it with deterministicParse,
 *   and return normalized fields used by the rest of the consumer.
 * - If deterministicParse fails, it falls back to callLLMFallback (stub you have).
 */
export type FallbackResult = {
  title?: string | null;
  current_price?: string | number | null;
  image_url?: string | null;
  currency?: string | null;
  credibility_score?: number;
  // allow other optional fields too
  [k: string]: any;
};

export async function fallbackExtract(url: string): Promise<FallbackResult> {
  let browser: import('playwright').Browser | null = null;
  let page: import('playwright').Page | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    // optional: set user-agent or viewport here if you need stealth
    // await page.setUserAgent('Mozilla/5.0 ...');

    // use your existing safeGoto which waits + retries
    try {
      await safeGoto(page, url);
    } catch (e) {
      // navigation failed — try a plain goto as last resort
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
      } catch (_e) { /* ignore */ }
    }

    // Now call deterministicParse on the page (await it)
    const parsed = await deterministicParse(page, { url });

    // Map parse result (title, price, image) to expected fields
    const title = parsed.title ?? null;
    const priceRaw = parsed.price ?? null;
    const image = parsed.image ?? null;

    // Try converting price string to number if looks numeric, else keep as string
    let current_price: number | string | null = null;
    if (priceRaw == null) {
      current_price = null;
    } else if (typeof priceRaw === 'number') {
      current_price = priceRaw;
    } else if (typeof priceRaw === 'string') {
      // try to parse numeric out of strings like "₹ 1,234" or "1,234.00"
      const cleaned = priceRaw.replace(/[^\d.,-]/g, '').trim();
      const num = Number(cleaned.replace(/,/g, ''));
      current_price = Number.isFinite(num) ? num : priceRaw;
    } else {
      current_price = String(priceRaw);
    }

    // credibility score heuristic: if we found all three fields, higher score
    const cred =
      (title ? 0.6 : 0) + (current_price ? 0.2 : 0) + (image ? 0.2 : 0);
    const credibility_score = Math.min(Math.max(cred, 0.0), 1.0) || 0.5;

    const out: FallbackResult = {
      title,
      current_price,
      image_url: image ?? null,
      currency: null, // unknown — leave null so later logic can set it to INR if needed
      credibility_score,
    };

    return out;
  } catch (err) {
    // If the deterministic parse fails completely, try LLM fallback (non-blocking)
    try {
      // callLLMFallback expects (task, context) in your stub — you only have url here,
      // so pass null task and minimal context. callLLMFallback returns similar shape.
      const llm = await callLLMFallback({ task_id: 'fallback', url } as any, null);
      // Normalize llm result to FallbackResult shape
      return {
        title: llm?.title ?? null,
        current_price: llm?.current_price ?? null,
        image_url: llm?.image_url ?? null,
        currency: llm?.currency ?? null,
        credibility_score: llm?.credibility_score ?? 0.5,
      };
    } catch (llmErr) {
      console.error('fallbackExtract: both deterministicParse and LLM fallback failed:', llmErr);
      return {
        title: null,
        current_price: null,
        image_url: null,
        currency: null,
        credibility_score: 0.0,
      };
    }
  } finally {
    try {
      if (page) await page.close().catch(() => null);
    } catch {}
    try {
      if (browser) await browser.close().catch(() => null);
    } catch {}
  }
}


// Optionally, if you have Node-side ES indexing helper, import it here and call later:
// import { indexScrapedProduct } from "../services/elastic_service";

// ---- types ----
type ScrapeResult = {
  product_id?: string | null;
  id?: string | null;
  title?: string | null;
  current_price?: number | string | null;
  currency?: string | null;
  source?: string | null;
  url?: string | null;
  image_url?: string | null;
  scraped_at?: string | null;
  error?: any;
  metadata?: any;
  raw?: any;
  user_id?: string | null;
  credibility_score?: number;
  provenance?: any[];
};

export type ScrapeTask = {
  task_id: string;
  url: string;
  // other fields you use elsewhere...
};

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export async function runFallbackExtraction(page: Page, task: ScrapeTask): Promise<ParseResult> {
  try {
    // Await the parse result (important — avoids "property does not exist on Promise" errors)
    const result = await deterministicParse(page, { url: task.url });
    return result;
  } catch (err: unknown) {
    const eAny = err as any;
    const htmlSnippet = eAny?.htmlSnippet ?? null;
    const url = (eAny?.url as string | undefined) ?? task.url ?? 'unknown';
    console.error(`Fallback failed for task=${task.task_id} url=${String(url)} error=${(err as Error).message ?? String(err)}`);

    console.error('Error details:', {
      task_id: task.task_id,
      url,
      htmlSnippetLength: htmlSnippet ? (htmlSnippet as string).length : 'n/a',
      stack: (err as Error).stack?.slice?.(0, 1000) ?? String(err),
    });

    // attempt a screenshot for inspection
    try {
      const screenshotsDir = path.resolve(process.cwd(), 'scraper-fail-screenshots');
      ensureDir(screenshotsDir);
      const fname = path.join(screenshotsDir, `${task.task_id.replace(/-/g, '')}.png`);
      // page.screenshot may throw; swallow errors
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (page as any).screenshot?.({ path: fname, fullPage: true }).catch(() => null);
      console.error(`Saved screenshot (if created) to ${fname}`);
    } catch (sErr) {
      console.error('Screenshot save failed:', sErr);
    }

    // rethrow to let upstream decide
    throw err;
  }
}


// Sanitize/normalize final stored result (avoid nulls for price/image/title per request)
function parsePriceToNumber(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    // remove currency symbols, non-digit except dot and comma, then normalize commas
    const cleaned = v.replace(/[^\d.,]/g, "").trim();
    if (!cleaned) return null;
    // remove commas
    const n = Number(cleaned.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function sanitizeScraped(raw: Partial<ScrapeResult> = {}): ScrapeResult {
  const now = new Date().toISOString();
  const productId = raw.product_id ?? raw.id ?? String(Date.now());
  const title =
    typeof raw.title === "string" && raw.title.trim()
      ? raw.title.trim()
      : "Unknown Product";

  // ensure price is numeric if possible, fallback to 0 (you asked "no null price")
  const parsedPrice = parsePriceToNumber(raw.current_price);
  const current_price = parsedPrice ?? 0;

  return {
    product_id: productId,
    id: productId,
    title,
    current_price,
    currency: raw.currency ?? (current_price ? "INR" : null),
    source: raw.source ?? "unknown",
    url: raw.url ?? "",
    image_url: raw.image_url ?? "", // no null allowed
    scraped_at: raw.scraped_at ?? now,
    error: raw.error ?? null,
    metadata: raw.metadata ?? {},
    raw: raw.raw ?? null,
    user_id: raw.user_id ?? null,
    credibility_score: typeof raw.credibility_score === "number" ? raw.credibility_score : 0.5,
    provenance: raw.provenance ?? []
  };
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down scraper worker (SIGINT)...");
  try {
    await closeBrowser();
  } catch (err) {
    console.warn("Error closing browser:", err);
  }
  try {
    await redisClient.quit();
  } catch {}
  try {
    if (channel) await channel.close();
  } catch {}
  process.exit(0);
});

export async function safeGoto(page: Page, url: string): Promise<string> {
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(600);
      const html = await page.content();
      if (html && html.length > 100) return html;
      // otherwise retry
    } catch (e) {
      if (attempt === maxAttempts) throw e;
    }
  }
  // final fallback
  return await page.content();
}

// Replace the existing callLLMFallback with this implementation.
export async function callLLMFallback(
  task: ScrapeTask,
  context: { title?: string; price?: string; image?: string } | null
): Promise<{
  title?: string | null;
  current_price?: string | number | null;
  image_url?: string | null;
  currency?: string | null;
  credibility_score?: number;
  [k: string]: any;
}> {
  // TODO: replace this stub with your real LLM call.
  // For now, return normalized shape with credibility_score so TypeScript and downstream code are happy.
  const title = context?.title ?? null;
  const price = context?.price ?? null;
  const image = context?.image ?? null;

  // Heuristic for credibility: if the LLM proposed values, give it a moderate score.
  const cred =
    (title ? 0.5 : 0) +
    (price ? 0.25 : 0) +
    (image ? 0.25 : 0);

  const credibility_score = Math.min(Math.max(cred, 0.0), 1.0) || 0.5;

  return {
    title,
    current_price: price ?? null,
    image_url: image ?? null,
    currency: null,
    credibility_score,
  };
}


// main consumer
(async () => {
  try {
    await connectRedis();
    console.log("✔ Redis connected (scraper)");

    // Initialize RabbitMQ channel
    await connectQueue();
    if (!channel) {
      console.error("❌ Failed to initialize RabbitMQ channel");
      process.exit(1);
    }

    await channel.assertQueue("scrape_queue", { durable: true });
    console.log("✔ Scraper worker listening on queue: scrape_queue");

    channel.consume("scrape_queue", async (msg: ConsumeMessage | null) => {
      if (!msg) return;

      let task_id: string | null = null;
      let url: string | null = null;

      try {
        // parse the incoming message
        let payload: any;
        try {
          payload = JSON.parse(msg.content.toString());
        } catch (err) {
          console.error("❌ Failed to parse message:", err);
          channel!.ack(msg);
          return;
        }

        // support several possible key names
        task_id =
          payload?.task_id ??
          payload?.taskId ??
          payload?.id ??
          null;

        url =
          payload?.url ??
          payload?.productUrl ??
          payload?.product_url ??
          null;

        if (!task_id) {
          console.error("❌ Missing task_id in payload:", payload);
          channel!.ack(msg);
          return;
        }
        if (!url) {
          console.error("❌ Missing url in payload:", payload);
          channel!.ack(msg);
          return;
        }

        console.log(`➡️ Received scrape job (task_id=${task_id}) for url: ${url}`);

        // SCRAPE_START
        const started = Date.now();
        console.log(`SCRAPE_START id=${task_id} url=${url} ts=${new Date().toISOString()}`);

        // Call site-specific scraper (this returns a partial result, may contain nulls)
        let rawScraped: Partial<ScrapeResult> = {};
        try {
          rawScraped = (await scrapeProduct(task_id, url)) as Partial<ScrapeResult>;
        } catch (scrErr) {
          // Scraper-level error -> write minimal failure record and continue flow
          console.warn(`Scrape function threw for task=${task_id}:`, scrErr);
          rawScraped = {
            product_id: null,
            id: null,
            title: null,
            current_price: null,
            currency: null,
            source: null,
            url,
            image_url: null,
            scraped_at: new Date().toISOString(),
            error: String(scrErr)
          };
        }

        // If scraper returned an error field, or missing key fields, attempt fallback
        const needsPrice = rawScraped.current_price == null;
        const needsImage = !rawScraped.image_url;
        const needsTitle = !rawScraped.title;

        if ((needsPrice || needsImage || needsTitle) && !rawScraped.error) {
          console.log(`Fallback: trying fallbackExtract for task=${task_id} (needsPrice=${needsPrice} needsImage=${needsImage} needsTitle=${needsTitle})`);
          try {
            const fallback = await fallbackExtract(url);

            // Merge in missing fields from fallback
            if (needsTitle && fallback.title) rawScraped.title = fallback.title;
            if (needsPrice && fallback.current_price != null) {
              rawScraped.current_price = fallback.current_price;
              rawScraped.currency = fallback.currency ?? rawScraped.currency ?? "INR";
            }
            if (needsImage && fallback.image_url) rawScraped.image_url = fallback.image_url;

            // provenance and credibility adjustments
            rawScraped.provenance = rawScraped.provenance ?? [];
            rawScraped.provenance.push({ fallback: true, ts: new Date().toISOString() });
            rawScraped.credibility_score = Math.min(
              (rawScraped.credibility_score ?? 0.5),
              (fallback.credibility_score ?? 0.5)
            );
          } catch (fbErr) {
            console.warn("Fallback failed:", fbErr);
          }
        }

        // Attach product_id/user_id from payload if provided
        if (payload?.product_id && !rawScraped?.product_id) {
          rawScraped.product_id = payload.product_id;
        } else if (payload?.productId && !rawScraped?.product_id) {
          rawScraped.product_id = payload.productId;
        }

        if (payload?.user_id) {
          rawScraped.user_id = payload.user_id;
        } else if (payload?.userId) {
          rawScraped.user_id = payload.userId;
        }

        // Normalize / sanitize to avoid null price/image/title
        const result = sanitizeScraped(rawScraped);

        // Store the result into Redis: HSET scrape:result:<task_id> result "<json>"
        try {
          await redisClient.hSet(`scrape:result:${task_id}`, "result", JSON.stringify(result));
          await redisClient.expire(`scrape:result:${task_id}`, 60 * 60 * 24 * 7);
        } catch (redisErr) {
          console.error("❌ Failed to write scrape result to Redis:", redisErr);
        }

        // Trigger Python backend to index the result into Elasticsearch and Price History
        try {
          const fetch = (await import("node-fetch")).default;
          const webhookUrl = `http://fastapi_app:8000/scrape/result/${task_id}`;
          console.log(`Webhooking Python backend to index result: ${webhookUrl}`);
          const res = await fetch(webhookUrl);
          if (!res.ok) {
            console.error(`Webhook failed with status ${res.status}:`, await res.text());
          }
        } catch (webhookErr) {
          console.warn("Failed to trigger indexing webhook:", webhookErr);
        }

        const duration = ((Date.now() - started) / 1000).toFixed(3);
        console.log(`SCRAPE_DONE id=${task_id} duration_s=${duration} ts=${new Date().toISOString()}`);

        if (result.error) {
          console.warn(`⚠️ Scrape finished with error (task_id=${task_id}): ${result.error}`);
        } else {
          console.log(`✔ Scrape completed and stored (task_id=${task_id})`);
        }

        channel!.ack(msg);

      } catch (err: any) {
        console.error("❌ Scrape processing error:", err);

        console.log(
          `SCRAPE_FAIL id=${task_id ?? "unknown"} error=${(err?.stack ?? err)
            .toString()
            .replace(/\s+/g, " ")} ts=${new Date().toISOString()}`
        );

        try {
          channel!.nack(msg, false, false);
        } catch (ackErr) {
          console.error("❌ Failed to nack message:", ackErr);
        }
      }
    });

  } catch (err: any) {
    console.error("Fatal scraper error:", err);
    process.exit(1);
  }
})();
