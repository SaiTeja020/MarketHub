// src/scraper/consumer.ts

import { connectQueue, channel } from "../utils/rabbitmq";
import { redisClient } from "../utils/redis";
import { runScraper } from "./runScraper";

(async () => {
  // Connect to RabbitMQ and create channel
  await connectQueue();

  console.log("✔ Scraper worker connected to RabbitMQ");

  // Ensure queue exists
  await channel.assertQueue("scrape_queue");
  console.log("✔ Listening on queue: scrape_queue");

  // Consume messages
  channel.consume("scrape_queue", async (msg: any) => {
    if (!msg) return;

    try {
      const payload = JSON.parse(msg.content.toString());
      const { productId } = payload;

      console.log(`➡️ Received scrape job for: ${productId}`);

      // The frontend sends productId instead of URL
      // You need to build the URL OR modify API call
      // For now assume URL is sent instead
      const { url } = payload;
      const result = await runScraper(url);

      // Save using url or extracted product_id
      await redisClient.set(`scrape:result:${task_id}`, JSON.stringify(result));

      console.log(`✔ Scrape completed for ${productId}`);

      channel.ack(msg);
    } catch (err) {
      console.error("❌ Scrape error:", err);
      channel.nack(msg);
    }
  });
})();
