// src/scraper/consumer.ts

import { connectQueue, channel } from "../utils/rabbitmq";
import redisClient, { connectRedis } from "../utils/redis";
import { scrapeProduct } from "./scrapeProduct";
import type { ConsumeMessage } from "amqplib";
import { closeBrowser } from "./browserPool";

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
        let payload: any;
        try {
          payload = JSON.parse(msg.content.toString());
        } catch (err) {
          console.error("❌ Failed to parse message:", err);
          channel!.ack(msg);
          return;
        }

        task_id =
          payload.task_id ??
          payload.productId ??
          payload.id ??
          null;

        if (!task_id) {
          console.error("❌ Missing task_id:", payload);
          channel!.ack(msg);
          return;
        }

        url =
          payload.url ??
          payload.productUrl ??
          payload.product_url ??
          null;

        if (!url) {
          console.error("❌ Missing url:", payload);
          channel!.ack(msg);
          return;
        }

        console.log(`➡️ Received scrape job (task_id=${task_id}) for url: ${url}`);

        // --------------------------
        // SCRAPE_START
        // --------------------------
        const started = Date.now();
        console.log(
          `SCRAPE_START id=${task_id} url=${url} ts=${new Date().toISOString()}`
        );

        // Run scraper
        const result = await scrapeProduct(task_id, url);

        // --------------------------
        // SCRAPE_DONE
        // --------------------------
        const duration = ((Date.now() - started) / 1000).toFixed(3);
        console.log(
          `SCRAPE_DONE id=${task_id} duration_s=${duration} ts=${new Date().toISOString()}`
        );

        // Store the result in Redis
        await redisClient.hSet(`scrape:result:${task_id}`, {
          result: JSON.stringify(result),
        });
        await redisClient.expire(
          `scrape:result:${task_id}`,
          60 * 60 * 24 * 7 // 7 days
        );

        if (result.error) {
          console.warn(`⚠️ Scrape finished with error (task_id=${task_id}): ${result.error}`);
        } else {
          console.log(`✔ Scrape completed and stored (task_id=${task_id})`);
        }

        channel!.ack(msg);

      } catch (err: any) {
        console.error("❌ Scrape processing error:", err);

        // --------------------------
        // SCRAPE_FAIL
        // --------------------------
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
