// src/scraper/consumer.ts
import { connectQueue, channel } from "../utils/rabbitmq";
import redisClient, { connectRedis } from "../utils/redis";
import { scrapeProduct } from "./scrapeProduct";
import type { ConsumeMessage } from "amqplib";
import { closeBrowser } from "./browserPool";
import { fallbackExtract } from "./fallbackExtractor";

// If you have an indexing helper in Node, import it here:
// import { indexScrapedProduct } from "../services/elastic_service";

/**
 * Allow nulls explicitly in the type so 'string | null' is allowed where TS
 * previously expected 'string | undefined' — this resolves that incompatibility.
 */
type ScrapeResult = {
  product_id?: string | null;
  id?: string | null;
  title?: string | null;
  current_price?: number | null;
  currency?: string | null;
  source?: string | null;
  url?: string | null;
  image_url?: string | null;
  scraped_at?: string | null;
  error?: any | null;
  metadata?: any | null;
  raw?: any | null;
  user_id?: string | null;
  provenance?: any[] | null;
  credibility_score?: number | null;
};

// parse numeric price from various possible shapes
function parsePrice(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const digits = v.replace(/[^\d.]/g, "");
    if (!digits) return null;
    const n = Number(digits);
    return Number.isFinite(n) ? n : null;
  }
  // support nested objects or uncommon shapes
  if (typeof v === "object") {
    try {
      const s = JSON.stringify(v);
      const digits = s.replace(/[^\d.]/g, "");
      if (!digits) return null;
      const n = Number(digits);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Turn an incoming (possibly sparse) scraped object into a canonical shape. */
function sanitizeScraped(scraped: Partial<ScrapeResult>): ScrapeResult {
  const productId = scraped?.product_id ?? scraped?.id ?? String(Date.now());
  const priceCandidate = scraped?.current_price ?? (scraped as any)?.price ?? null;
  const priceParsed = parsePrice(priceCandidate);

  const title = typeof scraped?.title === "string" && scraped.title.trim()
    ? scraped.title.trim()
    : "Unknown Product";

  return {
    product_id: productId,
    id: productId,
    title,
    current_price: priceParsed ?? 0,           // never null per your request
    currency: scraped?.currency ?? (priceParsed ? "INR" : null),
    source: scraped?.source ?? "unknown",
    url: scraped?.url ?? "",
    image_url: scraped?.image_url ?? "",        // never null (empty string)
    scraped_at: scraped?.scraped_at ?? new Date().toISOString(),
    error: scraped?.error ?? null,
    raw: scraped?.raw ?? null,
    metadata: scraped?.metadata ?? {},
    user_id: scraped?.user_id ?? null,
    provenance: scraped?.provenance ?? [],
    credibility_score: typeof scraped?.credibility_score === "number" ? scraped!.credibility_score! : 0.5
  };
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down scraper worker (SIGINT)...");
  try { await closeBrowser(); } catch (err) { console.warn("Error closing browser:", err); }
  try { await redisClient.quit(); } catch {}
  try { if (channel) await channel.close(); } catch {}
  process.exit(0);
});

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
        // parse incoming payload
        let payload: any;
        try {
          payload = JSON.parse(msg.content.toString());
        } catch (err) {
          console.error("❌ Failed to parse message payload:", err);
          channel!.ack(msg);
          return;
        }

        // tolerant key names
        task_id = payload?.task_id ?? payload?.taskId ?? payload?.id ?? null;
        url = payload?.url ?? payload?.productUrl ?? payload?.product_url ?? null;

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

        // Call site-specific scraper — treat result as Partial since it may contain nulls
        let rawScraped: Partial<ScrapeResult> = {};
        try {
          rawScraped = (await scrapeProduct(task_id, url)) as Partial<ScrapeResult>;
        } catch (scrapeErr: any) {
          rawScraped = { error: scrapeErr?.message ?? String(scrapeErr) };
        }

        // copy product_id/user_id from payload if missing
        if (!rawScraped.product_id) {
          rawScraped.product_id = payload?.product_id ?? payload?.productId ?? payload?.id ?? null;
        }
        if (!rawScraped.user_id) {
          rawScraped.user_id = payload?.user_id ?? payload?.userId ?? null;
        }

        // Fallback extraction if price/image/title missing
        const needsPrice = rawScraped.current_price == null;
        const needsImage = !rawScraped.image_url;
        const needsTitle = !rawScraped.title || (typeof rawScraped.title === "string" && !rawScraped.title.trim());

        if (!rawScraped.error && (needsPrice || needsImage || needsTitle)) {
          try {
            console.log(`Fallback for task=${task_id} needsPrice=${needsPrice} needsImage=${needsImage} needsTitle=${needsTitle}`);
            const fb: any = await fallbackExtract(url);

            if (needsTitle && fb?.title) rawScraped.title = fb.title;
            if (needsPrice && fb?.current_price != null) {
              rawScraped.current_price = fb.current_price;
              rawScraped.currency = fb.currency ?? rawScraped.currency ?? "INR";
            }
            if (needsImage && fb?.image_url) rawScraped.image_url = fb.image_url;

            rawScraped.provenance = rawScraped.provenance ?? [];
            rawScraped.provenance.push({ fallback: true, timestamp: new Date().toISOString() });
            rawScraped.credibility_score = Math.min((rawScraped.credibility_score ?? 0.5), (fb?.credibility_score ?? 0.5));
          } catch (fbErr) {
            console.warn("Fallback extraction failed:", fbErr);
          }
        }

        // Sanitize to ensure no nulls for price/image
        const result = sanitizeScraped(rawScraped);

        // Write to Redis in the exact shape FastAPI expects
        try {
          await redisClient.hSet(`scrape:result:${task_id}`, "result", JSON.stringify(result));
          await redisClient.expire(`scrape:result:${task_id}`, 60 * 60 * 24 * 7);
        } catch (redisErr) {
          console.error("❌ Failed to write scrape result to Redis:", redisErr);
        }

        // Optional: index into ES from Node if desired (uncomment if implemented)
        // try { await indexScrapedProduct(result); } catch (e) { console.warn("Indexing failed:", e); }

        const duration = ((Date.now() - started) / 1000).toFixed(3);
        console.log(`SCRAPE_DONE id=${task_id} duration_s=${duration} ts=${new Date().toISOString()}`);

        if (result.error) {
          console.warn(`⚠️ Scrape finished with error (task_id=${task_id}): ${result.error}`);
        } else {
          console.log(`✔ Scrape completed and stored (task_id=${task_id})`);
        }

        channel!.ack(msg);
      } catch (err: any) {
        console.error("❌ Scrape processing error (fatal):", err);
        console.log(
          `SCRAPE_FAIL id=${task_id ?? "unknown"} error=${(err?.stack ?? err).toString().replace(/\s+/g, " ")} ts=${new Date().toISOString()}`
        );
        try { channel!.nack(msg, false, false); } catch (ackErr) { console.error("❌ Failed to nack message:", ackErr); }
      }
    });
  } catch (err: any) {
    console.error("Fatal scraper error:", err);
    process.exit(1);
  }
})();
