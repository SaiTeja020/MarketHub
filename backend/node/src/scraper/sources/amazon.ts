// src/scraper/sources/amazon.ts
import { getBrowser } from "../browserPool";
import type { Page } from "playwright";

function extractASIN(url: string) {
  const match = url.match(/\/dp\/([A-Z0-9]{10})/i);
  return match ? match[1] : Date.now().toString();
}

function parsePriceText(priceText: string | null) {
  if (!priceText) return null;
  // remove non-digits except decimal separator
  const cleaned = priceText.replace(/[^\d.,]/g, "").replace(/,/g, "");
  const m = cleaned.match(/(\d+(\.\d+)?)/);
  return m ? parseFloat(m[0]) : null;
}

async function tryJsonLdPrice(page: Page):Promise<number | null> {
  try {
    const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
    for (const j of ld) {
      try {
        const obj = JSON.parse(j);
        // handle array or single object
        const items = Array.isArray(obj) ? obj : [obj];
        for (const it of items) {
          if (it && it.offers && (it.offers.price || it.offers.priceSpecification)) {
            const price = it.offers.price ?? (it.offers.priceSpecification && it.offers.priceSpecification.price);
            if (price) return parseFloat(String(price));
          }
          if (it && it.offers && Array.isArray(it.offers)) {
            for (const off of it.offers) {
              if (off.price) return parseFloat(String(off.price));
            }
          }
        }
      } catch (err) {
        // ignore parse errors
      }
    }
  } catch (err) {}
  return null;
}

export async function scrapeAmazon(url: string) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // wait briefly for product title or main area
    await page.waitForTimeout(400); // small pause
    const title =
      (await page.locator("#productTitle").textContent().catch(() => null)) ||
      (await page.locator("#titleSection, .product-title-word-break").first().textContent().catch(() => null)) ||
      (await page.locator("h1").first().textContent().catch(() => null)) ||
      null;

    // Try many price selectors
    const priceSelectors = [
      ".a-price .a-offscreen",
      "#priceblock_ourprice",
      "#priceblock_dealprice",
      "#priceBlock .a-price-whole",
      ".priceBlockBuyingPriceString",
      ".apexPriceToPay .a-offscreen",
      ".offer-price"
    ];

    let priceText: string | null = null;
    for (const sel of priceSelectors) {
      const t = await page.locator(sel).first().textContent().catch(() => null);
      if (t && t.trim()) {
        priceText = t.trim();
        break;
      }
    }

    let price = parsePriceText(priceText);
    if (!price) price = await tryJsonLdPrice(page);

    // Try image selectors then meta tag
    let imageUrl =
      (await page.locator("#landingImage").getAttribute("src").catch(() => null)) ||
      (await page.locator("#imgTagWrapperId img").first().getAttribute("src").catch(() => null)) ||
      (await page.locator("img#main-image, img#img-canvas img").first().getAttribute("src").catch(() => null)) ||
      null;

    if (!imageUrl) {
      // meta OG fallback
      imageUrl = (await page.locator('meta[property="og:image"]').getAttribute("content").catch(() => null)) ||
                 (await page.locator('meta[name="og:image"]').getAttribute("content").catch(() => null)) ||
                 null;
    }

    // final fallback: attempt JSON-LD images
    if (!imageUrl) {
      try {
        const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
        for (const j of ld) {
          try {
            const obj = JSON.parse(j);
            if (obj && obj.image) {
              if (typeof obj.image === "string") {
                imageUrl = obj.image;
                break;
              }
              if (Array.isArray(obj.image) && obj.image.length) {
                imageUrl = obj.image[0];
                break;
              }
            }
          } catch (_) {}
        }
      } catch (_) {}
    }

    return {
      product_id: extractASIN(url),
      title: title?.trim() || null,
      current_price: price ?? null,
      currency: price ? "INR" : null,
      source: "amazon",
      url,
      image_url: imageUrl ?? null,
      scraped_at: new Date().toISOString()
    };
  } finally {
    try { await page.close(); } catch (_) {}
  }
}
