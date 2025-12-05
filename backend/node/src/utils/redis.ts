// src/utils/redis.ts
import { createClient } from "redis";

const client = createClient({
  url: process.env.REDIS_URL,
});

export const connectRedis = async () => {
  if (!client.isOpen) {
    await client.connect();
    console.log("✔ Redis connected");
  }
};

export default client;
