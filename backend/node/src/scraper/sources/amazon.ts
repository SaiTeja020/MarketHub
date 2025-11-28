// src/scraper/sources/amazon.ts

import { chromium } from "playwright";

function extractASIN(url: string) {
  const match = url.match(/\/dp\/([A-Z0-9]{10})/);
  return match ? match[1] : Date.now().toString();
}

export async function scrapeAmazon(url: string) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  const title = await page.locator("#productTitle").textContent().catch(() => null);
  const priceWhole = await page.locator(".a-price-whole").first().textContent().catch(() => null);
  const priceFrac = await page.locator(".a-price-fraction").first().textContent().catch(() => null);
  const imageUrl = await page.locator("#landingImage").getAttribute("src").catch(() => null);

  const price = parseInt(
    `${priceWhole || ""}${priceFrac || ""}`.replace(/\D/g, "") || "0"
  );

  await browser.close();

  return {
    product_id: extractASIN(url),
    title: title?.trim() || "Unknown Product",
    current_price: price || null,
    currency: "INR",
    source: "amazon",
    url,
    image_url: imageUrl,
    scraped_at: new Date().toISOString()
  };
}
