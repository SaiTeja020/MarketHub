// backend/node/src/utils/playwright_retry.js
// CommonJS example — adapt path/naming to your repo layout.

async function newPageWithRetries(browserPool, maxRetries = 3, logger = console) {
    // browserPool should expose either .browser or .getBrowser/restartBrowser depending on your implementation.
    // Adjust the calls below to match the API of your browserPool object.
    let attempt = 0;
    let lastErr = null;
  
    while (++attempt <= maxRetries) {
      try {
        // If your pool returns a browser instance:
        const browser = await browserPool.getBrowser?.() || browserPool.browser || browserPool;
        // If your pool expects creating a context (preferred):
        if (typeof browser.newContext === 'function') {
          const context = await browser.newContext();
          const page = await context.newPage();
          return { browser, context, page };
        } else if (typeof browser.newPage === 'function') {
          // old style
          const page = await browser.newPage();
          return { browser, context: null, page };
        } else {
          throw new Error('browser object does not support newPage/newContext');
        }
      } catch (err) {
        lastErr = err;
        logger.warn(`newPageWithRetries: attempt ${attempt} failed: ${err && err.message ? err.message : err}`);
        // try to restart the browser in pool if available
        try {
          if (browserPool.restartBrowser) {
            await browserPool.restartBrowser();
            logger.info('browserPool.restartBrowser() called');
          } else if (browserPool.recreate) {
            await browserPool.recreate();
            logger.info('browserPool.recreate() called');
          } else {
            // fallback: try closing existing browser if any and re-initialize (if you have init)
            if (browserPool.browser && browserPool.browser.close) {
              try { await browserPool.browser.close(); } catch(e) {}
            }
            if (browserPool.init) {
              try { await browserPool.init(); } catch(e) {}
            }
          }
        } catch (e2) {
          logger.warn('browserPool restart attempt failed: ' + (e2 && e2.message ? e2.message : e2));
        }
  
        if (attempt < maxRetries) {
          // exponential backoff
          await new Promise(r => setTimeout(r, 500 * attempt));
          continue;
        } else {
          throw lastErr;
        }
      }
    }
  }
  
  module.exports = { newPageWithRetries };
  