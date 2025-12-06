// src/scraper/sources/amazon.ts
import { getBrowser } from "../browserPool";

function extractASIN(url: string) {
  const match = url.match(/\/dp\/([A-Z0-9]{10})/);
  return match ? match[1] : Date.now().toString();
}

export async function scrapeAmazon(url: string) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    const title = await page.locator("#productTitle").textContent().catch(() => null);
    // try multiple price selectors as fallback
    const priceSelectors = [".a-price .a-offscreen", ".a-price-whole", ".a-price"];
    let priceText = null;
    for (const sel of priceSelectors) {
      priceText = (await page.locator(sel).first().textContent().catch(() => null)) || priceText;
    }

    const imageUrl = await page.locator("#landingImage").getAttribute("src").catch(() => null);

    const price = parseInt((priceText || "").replace(/\D/g, "") || "0");

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
  } finally {
    await page.close();
  }
}
