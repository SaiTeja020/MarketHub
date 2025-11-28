// src/scraper/runScraper.ts

import { scrapeAmazon } from "./sources/amazon";
import { scrapeFlipkart } from "./sources/flipkart";

export async function runScraper(url: string) {
  url = url.toLowerCase();

  if (url.includes("amazon")) {
    return await scrapeAmazon(url);
  }

  if (url.includes("flipkart")) {
    return await scrapeFlipkart(url);
  }

  throw new Error("Unsupported website: Only Amazon and Flipkart are supported.");
}
