// src/scraper/consumer.ts
import { connectQueue, channel } from "../utils/rabbitmq";
import redisClient, { connectRedis } from "../utils/redis";
import { scrapeProduct } from "./scrapeProduct";
import type { ConsumeMessage } from "amqplib";
import { closeBrowser } from "./browserPool";

// Optional: if you have an indexing helper available in the Node service, import it.
// import { indexScrapedProduct } from "../services/elastic_service";

// helper to normalise scraped output

// after imports
type ScrapeResult = {
  product_id?: string;
  id?: string;
  title?: string;
  current_price?: number | string | null;
  currency?: string | null;
  source?: string | null;
  url?: string | null;
  image_url?: string | null;
  scraped_at?: string | null;
  error?: any;
  metadata?: any;
  raw?: any;
  user_id?: string | null;   // <<< add this
};

function sanitizeScraped(scraped: any): any {
  // Ensure fields exist and are not null
  const out = {
    product_id: scraped?.product_id ?? scraped?.id ?? String(Date.now()),
    id: scraped?.id ?? scraped?.product_id ?? String(Date.now()),
    title: (typeof scraped?.title === "string" && scraped.title.trim()) ? scraped.title.trim() : "Unknown Product",
    current_price: typeof scraped?.current_price === "number" ? scraped.current_price : (parsePrice(scraped?.current_price) ?? 0),
    currency: scraped?.currency ?? "INR",
    source: scraped?.source ?? "unknown",
    url: scraped?.url ?? "",
    image_url: scraped?.image_url ?? "",
    scraped_at: scraped?.scraped_at ?? new Date().toISOString(),
    error: scraped?.error ?? null,
    raw: scraped?.raw ?? null, // <<< add this
    // preserve any other metadata if present
    metadata: scraped?.metadata ?? {},
  };

  return out;
}

// small helper to try to parse numeric price strings (if any)
/** try to coerce a value (string like "₹ 12,345" or "12,345") into a number; returns number or null */
function parsePrice(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    // remove non-digit except dot
    const digits = v.replace(/[^\d.]/g, "");
    if (!digits) return null;
    const n = Number(digits);
    return Number.isFinite(n) ? n : null;
  }
  return null;
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

    // Begin consuming
    channel.consume("scrape_queue", async (msg: ConsumeMessage | null) => {
      if (!msg) return;

      let task_id: string | null = null;
      let url: string | null = null;

      try {
        // parse incoming payload (this is where user_id / product_id should live)
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

        // Call site-specific scraper. It should return an object (may contain nulls)
        const rawScraped: ScrapeResult = await scrapeProduct(task_id, url) as ScrapeResult;


        // Attach product_id/user_id from payload when not present in scraped data
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

        // Sanitize to avoid nulls (you requested no null price/image)
        const result = sanitizeScraped(rawScraped);

        // Store the result into Redis (shape: HSET scrape:result:<task_id> result "<json>")
        try {
          // redisClient.hSet supports both signature (key, field, value) or (key, object)
          // we write the single field 'result' as string for backward compatibility
          await redisClient.hSet(`scrape:result:${task_id}`, "result", JSON.stringify(result));
          // set retention
          await redisClient.expire(`scrape:result:${task_id}`, 60 * 60 * 24 * 7);
        } catch (redisErr) {
          console.error("❌ Failed to write scrape result to Redis:", redisErr);
        }

        // Optionally index into ES from Node if you have a function for that.
        // If you do, uncomment the import at top and call it here:
        // try { await indexScrapedProduct(result); } catch (e) { console.warn("Failed to index product in Node:", e); }

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
