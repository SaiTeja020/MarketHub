import { getBrowser } from "../browserPool";

function extractId(url: string) {
  // common Flipkart product id in URL (pid=)
  const m = url.match(/\/p\/.*\/([A-Za-z0-9_-]{10,})/) || url.match(/pid=([A-Za-z0-9_-]+)/);
  if (m && m[1]) return m[1];
  return Date.now().toString();
}

function parsePriceNumber(text: string | null) {
  if (!text) return null;
  const cleaned = text.replace(/\u00A0/g, " ").trim();
  const digits = cleaned.replace(/[^\d.,]/g, "");
  if (!digits) return null;
  if (digits.indexOf(",") !== -1 && digits.indexOf(".") !== -1) {
    return parseFloat(digits.replace(/,/g, ""));
  }
  return parseFloat(digits.replace(/,/g, ""));
}

export async function scrapeFlipkart(url: string) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "en-IN",
    viewport: { width: 1200, height: 800 },
  });
  const page = await context.newPage();

  try {
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-IN,en;q=0.9" });
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

    // Wait for typical product selectors
    await Promise.race([
      page.waitForSelector("span.B_NuCI", { timeout: 5000 }).catch(() => null),
      page.waitForSelector("span._35KyD6", { timeout: 5000 }).catch(() => null),
      page.waitForSelector("div._30jeq3", { timeout: 5000 }).catch(() => null),
    ]);

    const title =
      (await page.locator("span.B_NuCI").first().textContent().catch(() => null)) ||
      (await page.locator("span._35KyD6").first().textContent().catch(() => null)) ||
      (await page.locator("h1").textContent().catch(() => null));

    const priceText =
      (await page.locator("div._30jeq3._16Jk6d").first().textContent().catch(() => null)) ||
      (await page.locator("div._30jeq3").first().textContent().catch(() => null)) ||
      null;

    let imageUrl =
      (await page.locator("img._396cs4._2amPTt._3qGmMb").first().getAttribute("src").catch(() => null)) ||
      (await page.locator("img._2r_T1I").first().getAttribute("src").catch(() => null)) ||
      (await page.locator("meta[property='og:image']").getAttribute("content").catch(() => null)) ||
      null;

    // LD+JSON fallback
    if ((!priceText || !imageUrl) && (await page.$("script[type='application/ld+json']"))) {
      try {
        const ld = await page.$$eval("script[type='application/ld+json']", nodes =>
          nodes.map(n => {
            try { return JSON.parse(n.textContent || ""); } catch { return null; }
          })
        );
        for (const item of ld) {
          if (!item) continue;
          if (!priceText && item.offers?.price) {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            priceText = String(item.offers.price);
          }
          if (!imageUrl && item.image) {
            imageUrl = Array.isArray(item.image) ? item.image[0] : item.image;
          }
        }
      } catch (err) {
        // ignore
      }
    }

    const priceNum = parsePriceNumber(priceText);

    return {
      product_id: extractId(url),
      title: title ? title.trim() : null,
      current_price: priceNum,
      currency: priceNum ? "INR" : null,
      source: "flipkart",
      url,
      image_url: imageUrl || null,
      scraped_at: new Date().toISOString(),
      error: null,
    };
  } catch (err: any) {
    return {
      product_id: extractId(url),
      id: extractId(url),
      title: null,
      current_price: null,
      currency: null,
      source: "flipkart",
      url,
      image_url: null,
      scraped_at: new Date().toISOString(),
      error: err?.message || String(err),
    };
  } finally {
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
  }
}
