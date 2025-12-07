// src/scraper/sources/flipkart.ts
import { getBrowser } from "../browserPool";
import type { Page } from "playwright";

/**
 * Attempt to extract a stable product id from Flipkart URLs.
 * Falls back to timestamp string if nothing found.
 */
function extractId(url: string): string {
  const m1 = url.match(/\/p\/.*\/([A-Za-z0-9_-]{10,})/);
  if (m1 && m1[1]) return m1[1];

  const m2 = url.match(/[?&]pid=([A-Za-z0-9_-]+)/);
  if (m2 && m2[1]) return m2[1];

  // common Flipkart short urls may contain last path segment as id
  const m3 = url.split("/").filter(Boolean).pop();
  if (m3) return m3;

  return Date.now().toString();
}

/** Normalize a textual price into a number (tries to handle ₹, commas, decimals) */
function parsePriceNumber(text: string | null): number | null {
  if (!text) return null;
  const cleaned = text.replace(/\u00A0/g, " ").trim();
  // keep digits, dot and comma
  const digits = cleaned.replace(/[^\d.,]/g, "");
  if (!digits) return null;
  // If both comma and dot present, prefer dot as decimal separator (remove commas)
  if (digits.indexOf(",") !== -1 && digits.indexOf(".") !== -1) {
    return Number(digits.replace(/,/g, ""));
  }
  // otherwise remove commas
  const normalized = digits.replace(/,/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/** Try to parse price from JSON-LD <script type="application/ld+json"> blocks */
async function tryJsonLdPrice(page: Page): Promise<number | null> {
  try {
    const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
    for (const txt of blocks) {
      try {
        const obj = JSON.parse(txt);
        const items = Array.isArray(obj) ? obj : [obj];
        for (const it of items) {
          if (!it) continue;
          // common shape: offers.price or offers.priceSpecification.price
          if (it.offers) {
            const offers = Array.isArray(it.offers) ? it.offers : [it.offers];
            for (const off of offers) {
              const p = off?.price ?? off?.priceSpecification?.price;
              if (p) return parseFloat(String(p));
            }
          }
          // sometimes product has 'aggregateRating' etc - skip
        }
      } catch (_) {
        // ignore JSON parse errors
      }
    }
  } catch (_) {}
  return null;
}

/** Try to parse image from JSON-LD */
async function tryJsonLdImage(page: Page): Promise<string | null> {
  try {
    const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
    for (const txt of blocks) {
      try {
        const obj = JSON.parse(txt);
        const items = Array.isArray(obj) ? obj : [obj];
        for (const it of items) {
          if (!it) continue;
          if (it.image) {
            if (typeof it.image === "string") return it.image;
            if (Array.isArray(it.image) && it.image.length) return it.image[0];
          }
          if (it.offers && it.offers.image) {
            const img = it.offers.image;
            if (typeof img === "string") return img;
            if (Array.isArray(img) && img.length) return img[0];
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

export async function scrapeFlipkart(url: string): Promise<{
  product_id: string;
  title: string | null;
  current_price: number | null;
  currency: string | null;
  source: string;
  url: string;
  image_url: string | null;
  scraped_at: string;
  error?: string | null;
}> {
  const browser = await getBrowser();
  const page: Page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 600 });

    // small chance Flipkart lazy-loads; give a short pause
    await page.waitForTimeout(300);

    // Title fallbacks used on Flipkart product pages
    const title =
      (await page.locator("span.B_NuCI").first().textContent().catch(() => null)) ||
      (await page.locator("span.s1Q9rs").first().textContent().catch(() => null)) ||
      (await page.locator("h1").first().textContent().catch(() => null)) ||
      null;

    // Price fallbacks used on Flipkart
    const priceSelectors = [
      "div._30jeq3._16Jk6d", // typical product page
      "div._30jeq3", // alternate
      ".price._30jeq3", // sometimes classes differ
      "div._1vC4OE", // older patterns
      ".a-price .a-offscreen" // if Amazon-like markup (defensive)
    ];

    let priceText: string | null = null;
    for (const sel of priceSelectors) {
      const t = await page.locator(sel).first().textContent().catch(() => null);
      if (t && t.trim()) {
        priceText = t.trim();
        break;
      }
    }

    // Try JSON-LD price if no selector matched
    let price = parsePriceNumber(priceText);
    if (!price) price = await tryJsonLdPrice(page);

    // Image fallbacks
    let imageUrl =
      (await page.locator("img._396cs4._2amPTt._3qGmMb").first().getAttribute("src").catch(() => null)) ||
      (await page.locator("img._2r_T1I").first().getAttribute("src").catch(() => null)) ||
      (await page.locator("img._2r_T1I").first().getAttribute("data-src").catch(() => null)) ||
      (await page.locator("img._396cs4").first().getAttribute("data-src").catch(() => null)) ||
      null;

    // OG meta fallback
    if (!imageUrl) {
      imageUrl =
        (await page.locator('meta[property="og:image"]').getAttribute("content").catch(() => null)) ||
        (await page.locator('meta[name="og:image"]').getAttribute("content").catch(() => null)) ||
        null;
    }

    // JSON-LD image fallback
    if (!imageUrl) {
      imageUrl = await tryJsonLdImage(page);
    }

    const product_id = extractId(url);

    return {
      product_id,
      title: title?.trim() || null,
      current_price: price ?? null,
      currency: price ? "INR" : null,
      source: "flipkart",
      url,
      image_url: imageUrl ?? null,
      scraped_at: new Date().toISOString(),
      error: null
    };
  } catch (err: any) {
    // return an error object instead of throwing so caller can persist failure
    return {
      product_id: extractId(url),
      title: null,
      current_price: null,
      currency: null,
      source: "flipkart",
      url,
      image_url: null,
      scraped_at: new Date().toISOString(),
      error: String(err?.message ?? err)
    };
  } finally {
    try {
      await page.close();
    } catch (_) {
      // ignore close errors
    }
  }
}
