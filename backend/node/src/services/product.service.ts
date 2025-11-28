import { getCachedProduct, saveProductCache } from "./cache.service";

export const getProductData = async (productId: string) => {
  // step 1: check redis
  const cached = await getCachedProduct(productId);

  if (cached) return cached;

  // step 2: scrape immediately
  const scraped = await scrapeProduct(productId);

  // step 3: store new data
  await saveProductCache(productId, scraped);

  return { ...scraped, _action: "fresh_scrape" };
};

// dummy
async function scrapeProduct(id: string) {
  return {
    id,
    title: "Sample",
    price: Math.random() * 1000,
    updated_at: Date.now(),
  };
}
