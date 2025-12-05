// src/services/cache.service.ts
import redisClient, { connectRedis } from "../utils/redis";

/**
 * Retrieve product data from Redis cache
 */
export const getCachedProduct = async (productId: string) => {
  await connectRedis();

  const data = await redisClient.get(`product:${productId}`);

  if (!data) return null;

  try {
    return JSON.parse(data);
  } catch (err) {
    console.error("❌ Failed to parse cached product JSON:", err);
    return null;
  }
};

/**
 * Save product data into Redis cache
 */
export const saveProductCache = async (productId: string, productData: any) => {
  await connectRedis();

  await redisClient.set(
    `product:${productId}`,
    JSON.stringify(productData),
    { EX: 3600 } // TTL: 1 hour
  );
};
