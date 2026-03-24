// src/scraper/runScraper.ts

import { scrapeAmazon } from "./sources/amazon";
import { scrapeFlipkart } from "./sources/flipkart";

export async function runScraper(url: string) {
  const urlLower = url.toLowerCase();

  if (urlLower.includes("amazon")) {
    return await scrapeAmazon(url);
  }

  if (urlLower.includes("flipkart")) {
    return await scrapeFlipkart(url);
  }

  throw new Error("Unsupported website: Only Amazon and Flipkart are supported.");
}
