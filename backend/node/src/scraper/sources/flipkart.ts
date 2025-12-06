// src/scraper/sources/flipkart.ts
import { getBrowser } from "../browserPool";

function extractId(url: string) {
  return url.split("pid=")[1]?.split("&")[0] || Date.now().toString();
}

export async function scrapeFlipkart(url: string) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // title fallback
    const title =
      (await page.locator("span.B_NuCI").first().textContent().catch(() => null)) ||
      (await page.locator("span.s1Q9rs").first().textContent().catch(() => null)) ||
      null;

    // price fallback
    const priceText =
      (await page.locator("div._30jeq3._16Jk6d").first().textContent().catch(() => null)) ||
      (await page.locator("div._30jeq3").first().textContent().catch(() => null)) ||
      null;

    // image fallback
    const imageUrl =
      (await page.locator("img._396cs4._2amPTt._3qGmMb").first().getAttribute("src").catch(() => null)) ||
      (await page.locator("img._2r_T1I").first().getAttribute("src").catch(() => null)) ||
      null;

    const price = parseInt(priceText?.replace(/\D/g, "") || "0");

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
  } finally {
    try {
      await page.close();
    } catch (err) {
      // ignore
    }
  }
}
