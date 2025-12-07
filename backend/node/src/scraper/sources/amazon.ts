// src/scraper/sources/amazon.ts
import { newPageWithRetries } from "../../utils/newPage";

function extractASIN(url: string) {
  const match = url.match(/\/dp\/([A-Z0-9]{10})/);
  return match ? match[1] : Date.now().toString();
}

export async function scrapeAmazon(url: string) {
  const { context, page } = await newPageWithRetries(3);

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    const title = await page.locator("#productTitle").textContent().catch(() => null);

    const priceSelectors = [
      ".a-price .a-offscreen",
      ".a-price-whole",
      "#priceblock_ourprice",
      "#priceblock_dealprice",
    ];

    let priceText: string | null = null;

    for (const sel of priceSelectors) {
      const t = await page.locator(sel).first().textContent().catch(() => null);
      if (t) {
        priceText = t;
        break;
      }
    }

    const imageUrl =
      (await page.locator("#landingImage").getAttribute("src").catch(() => null)) ||
      (await page.locator("#imgTagWrapperId img").first().getAttribute("src").catch(() => null)) ||
      null;

    const price = parseInt((priceText || "").replace(/\D/g, "") || "0");

    return {
      product_id: extractASIN(url),
      title: title?.trim() || "Unknown Product",
      current_price: price || null,
      currency: "INR",
      source: "amazon",
      url,
      image_url: imageUrl,
      scraped_at: new Date().toISOString(),
    };
  } finally {
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
  }
}
