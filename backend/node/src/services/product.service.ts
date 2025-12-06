// src/services/product.service.ts
import { getCachedProduct, saveProductCache } from "./cache.service";
import { scrapeProduct } from "../scraper/scrapeProduct"; // shared scraper function

export const getProductData = async (productId: string, url?: string) => {
  // 1) check cache
  const cached = await getCachedProduct(productId);
  if (cached) return cached;

  // 2) require url to scrape if not cached
  if (!url) {
    throw new Error("No cached product and no URL provided to perform scrape.");
  }

  // 3) call shared scrapeProduct(taskId, url)
  const scraped = await scrapeProduct(productId, url);

  // 4) store into cache
  await saveProductCache(productId, scraped);

  return { ...scraped, _action: "fresh_scrape" };
};
