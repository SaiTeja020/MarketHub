// src/scraper/consumer.ts
import { connectQueue } from "../utils/rabbitmq";
import { getChannel } from "../services/scraperQueue.service";
import redisClient, { connectRedis } from "../utils/redis";
import { scrapeProduct } from "./scrapeProduct";
import type { ConsumeMessage } from "amqplib";

// top of file (where other imports are)
import { closeBrowser } from "./browserPool";

// at the bottom of the file, after the main IIFE or anywhere startup code runs:
process.on("SIGINT", async () => {
  console.log("Shutting down scraper worker (SIGINT)...");
  try { await closeBrowser(); } catch (err) { console.warn("Error closing browser:", err); }
  try { await redisClient.quit(); } catch {}
  try { const ch = getChannel(); if (ch) await ch.close(); } catch {}
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("Shutting down scraper worker (SIGTERM)...");
  try { await closeBrowser(); } catch (err) { console.warn("Error closing browser:", err); }
  try { await redisClient.quit(); } catch {}
  try { const ch = getChannel(); if (ch) await ch.close(); } catch {}
  process.exit(0);
});


(async () => {
  try {
    // Ensure RabbitMQ connection & channel exist
    await connectQueue();
    const channel = getChannel();
    if (!channel) {
      console.error("❌ RabbitMQ channel is not available after connectQueue()");
      process.exit(1);
    }

    // Limit to 1 unacked message at a time (Playwright is heavy)
    await channel.prefetch(1);

    // Connect Redis once at startup (idempotent)
    await connectRedis();

    // Make sure queue exists
    await channel.assertQueue("scrape_queue", { durable: true });
    console.log("✔ Scraper worker connected to RabbitMQ and listening on queue: scrape_queue");

    // Start consuming
    channel.consume("scrape_queue", async (msg: ConsumeMessage | null) => {
      if (!msg) return;

      try {
        let payload: any;
        try {
          payload = JSON.parse(msg.content.toString());
        } catch (err) {
          console.error("❌ Failed to parse message content:", err);
          channel.ack(msg);
          return;
        }

        const task_id =
          payload.task_id ??
          payload.taskId ??
          payload.productId ??
          payload.product_id ??
          payload.id ??
          null;

        if (!task_id) {
          console.error("❌ Message missing task_id / productId:", payload);
          channel.ack(msg);
          return;
        }

        const url = payload.url ?? payload.productUrl ?? payload.product_url ?? null;
        if (!url) {
          console.error("❌ Message missing url:", payload);
          channel.ack(msg);
          return;
        }

        console.log(`➡️ Received scrape job (task_id=${task_id}) for url: ${url}`);

        const result = await scrapeProduct(task_id, url);

        // Store result and set TTL (optional)
        await redisClient.hSet(`scrape:result:${task_id}`, { result: JSON.stringify(result) });
        await redisClient.expire(`scrape:result:${task_id}`, 60 * 60 * 24 * 7);

        if (result.error) {
          console.warn(`⚠️ Scrape finished with error for task ${task_id}: ${result.error}`);
        } else {
          console.log(`✔ Scrape completed and stored for task_id=${task_id}`);
        }

        channel.ack(msg);
      } catch (err: any) {
        console.error("❌ Scrape processing error:", err?.stack ?? err);
        try {
          channel.nack(msg, false, false);
        } catch (ackErr) {
          console.error("❌ Failed to nack message:", ackErr);
        }
      }
    });
  } catch (err: any) {
    console.error("Fatal error in scraper worker:", err?.stack ?? err);
    process.exit(1);
  }
})();