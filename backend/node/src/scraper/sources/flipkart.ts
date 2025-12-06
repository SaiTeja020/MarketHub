// src/scraper/sources/flipkart.ts

import { chromium } from "playwright";

function extractId(url: string) {
  return url.split("pid=")[1]?.split("&")[0] || Date.now().toString();
}

export async function scrapeFlipkart(url: string) {
  const browser = await chromium.launch({ headless: true ,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--single-process",
      "--disable-gpu",
    ],});
  const page = await browser.newPage();

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  const title = await page
    .locator("span.B_NuCI")
    .first()
    .textContent()
    .catch(() => null);

  const priceText = await page
    .locator("div._30jeq3._16Jk6d")
    .textContent()
    .catch(() => null);

  const imageUrl = await page
    .locator("img._396cs4._2amPTt._3qGmMb")
    .first()
    .getAttribute("src")
    .catch(() => null);

  const price = parseInt(priceText?.replace(/\D/g, "") || "0");

  await browser.close();

  return {
    product_id: extractId(url),
    title: title?.trim() || "Unknown Product",
    current_price: price || null,
    currency: "INR",
    source: "flipkart",
    url,
    image_url: imageUrl,
    scraped_at: new Date().toISOString()
  };
}
