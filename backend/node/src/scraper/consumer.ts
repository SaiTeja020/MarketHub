// src/scraper/consumer.ts
import { connectQueue  } from "../utils/rabbitmq";
import { getChannel } from "../services/scraperQueue.service";
import redisClient, { connectRedis } from "../utils/redis";
import { runScraper } from "./runScraper";
import type { ConsumeMessage } from "amqplib";

(async () => {
  try {
    // Ensure RabbitMQ connection & channel exist
    await connectQueue();
    const channel = getChannel();
    if (!channel) {
      console.error("❌ RabbitMQ channel is not available after connectQueue()");
      process.exit(1); // fatal: worker can't run without channel
    }

    // Make sure queue exists
    await channel.assertQueue("scrape_queue", { durable: true });
    console.log("✔ Scraper worker connected to RabbitMQ and listening on queue: scrape_queue");

    // Start consuming
    channel.consume("scrape_queue", async (msg: ConsumeMessage | null) => {
      if (!msg) return; // nothing to do

      try {
        // parse message safely
        let payload: any;
        try {
          payload = JSON.parse(msg.content.toString());
        } catch (err) {
          console.error("❌ Failed to parse message content:", err, msg.content.toString());
          channel.ack(msg);
          return;
        }

        // Accept common variants for task id / product id
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

        // Accept several possible url fields
        const url = payload.url ?? payload.productUrl ?? payload.product_url ?? null;
        if (!url) {
          console.error("❌ Message missing url:", payload);
          channel.ack(msg);
          return;
        }

        console.log(`➡️ Received scrape job (task_id=${task_id}) for url: ${url}`);

        // Run the scraper
        const result = await runScraper(url);

        // Ensure Redis is connected, then store result
        await connectRedis();
        // Store result as a hash with a field 'result' (you can add more fields if needed)
        await redisClient.hSet(`scrape:result:${task_id}`, { result: JSON.stringify(result) });

        console.log(`✔ Scrape completed and stored for task_id=${task_id}`);

        // acknowledge successful processing
        channel.ack(msg);
      } catch (err) {
        console.error("❌ Scrape processing error:", err);

        // nack: do not requeue by default to avoid poison messages; adjust as needed
        try {
          channel.nack(msg, false, false);
        } catch (ackErr) {
          console.error("❌ Failed to nack message:", ackErr);
        }
      }
    });
  } catch (err) {
    console.error("Fatal error in scraper worker:", err);
    process.exit(1);
  }
})();
