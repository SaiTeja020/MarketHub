import { getBrowser } from "../browserPool";

/** Extract ASIN from common amazon product URL patterns */
function extractASIN(url: string) {
  const match = url.match(/\/dp\/([A-Z0-9]{10})/i) || url.match(/\/product\/([A-Z0-9]{10})/i);
  return match ? match[1] : Date.now().toString();
}

function parsePriceNumber(text: string | null) {
  if (!text) return null;
  // Remove non-digit except dot and comma. Replace comma thousands, keep decimal dot if present.
  const cleaned = text.replace(/\u00A0/g, " ").trim();
  // Some prices like "₹ 1,23,456.00" or "1,234" — remove currency symbols and spaces then handle commas
  const digits = cleaned.replace(/[^\d.,]/g, "");
  if (!digits) return null;
  // If both comma and dot exist, assume dot is decimal separator: remove commas
  if (digits.indexOf(",") !== -1 && digits.indexOf(".") !== -1) {
    return parseFloat(digits.replace(/,/g, ""));
  }
  // If only commas exist, remove them and parse int
  if (digits.indexOf(",") !== -1 && digits.indexOf(".") === -1) {
    return parseFloat(digits.replace(/,/g, ""));
  }
  return parseFloat(digits);
}

async function extractFromLDJson(page: any) {
  try {
    const ld = await page.$$eval("script[type='application/ld+json']", (nodes: any[]) =>
      nodes.map((n: any) => {
        try {
          return JSON.parse(n.innerText);
        } catch {
          return null;
        }
      })
    );
    for (const item of ld) {
      if (!item) continue;
      // offer or product structure
      if (item.offers && item.offers.price) {
        return {
          price: item.offers.price,
          currency: item.offers.priceCurrency || null,
          title: item.name || null,
          image: Array.isArray(item.image) ? item.image[0] : item.image || null,
        };
      }
      if (item["@type"] === "Product") {
        return {
          price: item.offers?.price || null,
          currency: item.offers?.priceCurrency || null,
          title: item.name || null,
          image: Array.isArray(item.image) ? item.image[0] : item.image || null,
        };
      }
    }
  } catch (err) {
    // ignore
  }
  return null;
}

export async function scrapeAmazon(url: string) {
  const browser = await getBrowser();
  // create new context + page so headers/userAgent changes don't leak
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "en-IN",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  try {
    // Set Accept-Language to increase chance of consistent markup
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-IN,en;q=0.9" });

    // visit page, prefer networkidle to wait for js loads
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

    // If Amazon shows non-product page, try canonical redirect
    const canonical = await page.$eval("link[rel='canonical']", el => (el as HTMLLinkElement).href).catch(() => null);
    if (canonical && canonical.includes("/dp/") && canonical !== url) {
      // try navigate to canonical product url
      await page.goto(canonical, { waitUntil: "networkidle", timeout: 40000 }).catch(() => {});
    }

    // wait for either title or a price element — avoid waiting too long
    await Promise.race([
      page.waitForSelector("#productTitle", { timeout: 5000 }).catch(() => null),
      page.waitForSelector(".a-price", { timeout: 5000 }).catch(() => null),
      page.waitForSelector("#priceblock_ourprice", { timeout: 5000 }).catch(() => null),
    ]);

    // Title
    const title =
      (await page.locator("#productTitle").textContent().catch(() => null)) ||
      (await page.locator("span#title").textContent().catch(() => null)) ||
      (await page.locator("h1").textContent().catch(() => null));

    // Image fallbacks
    const imageCandidates = [
      () => page.locator("#landingImage").getAttribute("src").catch(() => null),
      () => page.locator("#imgTagWrapperId img").first().getAttribute("data-old-hires").catch(() => null),
      () => page.locator("#imgTagWrapperId img").first().getAttribute("src").catch(() => null),
      () => page.locator("meta[property='og:image']").getAttribute("content").catch(() => null),
      () => page.locator("meta[name='twitter:image']").getAttribute("content").catch(() => null),
    ];

    let imageUrl: string | null = null;
    for (const fn of imageCandidates) {
      const v = await fn();
      if (v) {
        imageUrl = v;
        break;
      }
    }

    // Price fallbacks
    const priceSelectors = [
      ".a-price .a-offscreen",
      "#priceblock_ourprice",
      "#priceblock_dealprice",
      "#priceblock_saleprice",
      ".a-color-price",
      ".priceBlockBuyingPriceString",
      ".apexPriceToPay .a-offscreen"
    ];

    let priceText: string | null = null;
    for (const sel of priceSelectors) {
      priceText = await page.locator(sel).first().textContent().catch(() => null);
      if (priceText) break;
    }

    // If price still not found, try LD+JSON
    let ld = await extractFromLDJson(page);
    if (!priceText && ld && ld.price) {
      priceText = String(ld.price);
      if (!imageUrl && ld.image) imageUrl = String(ld.image);
    }

    // Last resort: meta tags or og:price:amount
    if (!priceText) {
      priceText = (await page.locator("meta[property='product:price:amount']").getAttribute("content").catch(() => null)) ||
                  (await page.locator("meta[name='display_price']").getAttribute("content").catch(() => null)) ||
                  null;
    }

    const priceNum = parsePriceNumber(priceText);

    // final image fallback from structured data in DOM
    if (!imageUrl) {
      const ldImg = await page.evaluate(() => {
        try {
          const scripts = Array.from(document.querySelectorAll("script[type='application/ld+json']")).map(s => s.textContent);
          for (const raw of scripts) {
            if (!raw) continue;
            try {
              const j = JSON.parse(raw);
              if (j && j.image) return Array.isArray(j.image) ? j.image[0] : j.image;
            } catch {}
          }
        } catch {}
        return null;
      });
      if (ldImg) imageUrl = ldImg;
    }

    return {
      product_id: extractASIN(url),
      title: title ? title.trim() : null,
      current_price: priceNum,
      currency: priceNum ? "INR" : null,
      source: "amazon",
      url,
      image_url: imageUrl || null,
      scraped_at: new Date().toISOString(),
      error: null,
    };
  } catch (err: any) {
    return {
      product_id: extractASIN(url),
      id: extractASIN(url),
      title: null,
      current_price: null,
      currency: null,
      source: "amazon",
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
