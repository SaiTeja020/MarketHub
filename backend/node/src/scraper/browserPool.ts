// src/scraper/browserPool.ts
import { chromium, Browser } from "playwright";

let browser: Browser | null = null;

/**
 * Return a shared browser instance. Launches once lazily.
 */
export async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--single-process",
        "--disable-gpu",
      ],
    });
    // optional: log when browser launches
    console.log("✔ Playwright browser launched (browserPool)");
  }
  return browser;
}

/**
 * Close the shared browser (used on graceful shutdown).
 */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    try {
      await browser.close();
      console.log("✔ Playwright browser closed (browserPool)");
    } catch (err) {
      console.warn("⚠️ Failed to close browser", err);
    } finally {
      browser = null;
    }
  }
}
