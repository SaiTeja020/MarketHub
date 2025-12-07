// src/scraper/browserPool.ts
import { chromium, Browser } from "playwright";

let browser: Browser | null = null;

/**
 * Internal: actually launches the browser.
 * Used by getBrowser() and restartBrowser().
 */
async function launchBrowser(): Promise<Browser> {
  const instance = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--single-process",
      "--disable-gpu",
    ],
  });

  console.log("✔ Playwright browser launched (browserPool)");
  return instance;
}

/**
 * Returns the shared browser instance.
 * Automatically relaunches if it's closed or crashed.
 */
export async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await launchBrowser();
    return browser;
  }

  // Detect browser crash
  try {
    // If this throws, browser is dead
    browser.version();
  } catch (err) {
    console.warn("⚠ Browser instance is dead — restarting...");
    browser = await launchBrowser();
  }

  return browser;
}

/**
 * Force-restart the browser manually.
 * Used from retry logic when newPage() fails.
 */
export async function restartBrowser(): Promise<Browser> {
  console.warn("♻ Restarting browser (browserPool.restartBrowser)");

  if (browser) {
    try {
      await browser.close();
    } catch {}
  }

  browser = await launchBrowser();
  return browser;
}

/**
 * Close the shared browser gracefully.
 */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    try {
      await browser.close();
      console.log("✔ Playwright browser closed (browserPool)");
    } catch (err) {
      console.warn("⚠ Failed to close browser", err);
    } finally {
      browser = null;
    }
  }
}
