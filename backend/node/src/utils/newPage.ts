// src/scraper/utils/newPage.ts
import { getBrowser, restartBrowser } from "../scraper/browserPool";

export async function newPageWithRetries(max = 3) {
  let attempt = 0;
  let lastErr: any;

  while (++attempt <= max) {
    try {
      const browser = await getBrowser();

      // Always create a fresh context for each job (safer)
      const context = await browser.newContext();
      const page = await context.newPage();

      return { browser, context, page };
    } catch (err: any) {
      lastErr = err;
      console.warn(`newPage attempt ${attempt} failed: ${err.message}`);

      // Try restarting the browser if pool supports it
      try {
        await restartBrowser();
      } catch {}

      await new Promise(r => setTimeout(r, 300 * attempt));
    }
  }

  throw lastErr;
}
