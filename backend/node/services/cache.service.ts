import { redis } from "../utils/redis";
import { pushScrapeTask } from "./scraperQueue.service";

const ONE_HOUR = 60 * 60 * 1000;
const SIX_HOUR = 6 * ONE_HOUR;

export const getCachedProduct = async (productId: string) => {
  const key = `product:${productId}`;

  const cached = await redis.hGetAll(key);
  if (!cached || !cached.updated_at) return null;

  const age = Date.now() - Number(cached.updated_at);

  if (age < ONE_HOUR) {
    return { ...cached, _action: "fresh_cache" };
  }

  if (age >= ONE_HOUR && age < SIX_HOUR) {
    pushScrapeTask(productId);
    return { ...cached, _action: "stale_but_usable" };
  }

  return null;
};

export const saveProductCache = async (productId: string, data: any) => {
  const key = `product:${productId}`;

  await redis.hSet(key, {
    ...data,
    updated_at: Date.now().toString(),
  });
};
