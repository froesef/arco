/**
 * Playwright browser/context pool.
 *
 * Architecture: multiple browser contexts within shared browser instances.
 * Each context has full session isolation (separate sessionStorage, cookies).
 * Up to 10 contexts per browser instance for memory efficiency.
 */

import { chromium } from 'playwright';

const MAX_CONTEXTS_PER_BROWSER = 10;

export class BrowserPool {
  constructor({
    parallel, headless, viewportWidth, viewportHeight, loadtestToken,
  }) {
    this.parallel = parallel;
    this.headless = headless;
    this.viewportWidth = viewportWidth;
    this.viewportHeight = viewportHeight;
    this.loadtestToken = loadtestToken || '';

    this.browsers = [];
    this.availableContexts = [];
    this._waiters = [];
  }

  async initialize() {
    const browserCount = Math.max(1, Math.ceil(this.parallel / MAX_CONTEXTS_PER_BROWSER));
    const contextsPerBrowser = Math.ceil(this.parallel / browserCount);

    console.log(
      `[browser-pool] Launching ${browserCount} browser(s) `
      + `with ${contextsPerBrowser} contexts each (${this.parallel} total)`,
    );

    for (let b = 0; b < browserCount; b++) {
      const browser = await chromium.launch({ headless: this.headless });
      this.browsers.push(browser);

      const contextCount = Math.min(
        contextsPerBrowser,
        this.parallel - this.availableContexts.length,
      );

      for (let c = 0; c < contextCount; c++) {
        const context = await browser.newContext({
          viewport: { width: this.viewportWidth, height: this.viewportHeight },
          ignoreHTTPSErrors: true,
        });

        // Inject X-Loadtest-Token header on API requests to bypass rate limiting
        if (this.loadtestToken) {
          await context.route('**/api/generate', (route) => {
            const headers = { ...route.request().headers(), 'x-loadtest-token': this.loadtestToken };
            route.continue({ headers });
          });
        }

        this.availableContexts.push(context);
      }
    }

    console.log(`[browser-pool] Ready: ${this.availableContexts.length} contexts available`);
  }

  async acquireContext() {
    if (this.availableContexts.length > 0) {
      return this.availableContexts.pop();
    }
    // Wait for a context to become available
    return new Promise((resolve, reject) => {
      this._waiters.push({ resolve, reject });
    });
  }

  releaseContext(context) {
    if (this._waiters.length > 0) {
      const { resolve } = this._waiters.shift();
      resolve(context);
    } else {
      this.availableContexts.push(context);
    }
  }

  async shutdown() {
    console.log('[browser-pool] Shutting down...');

    // Reject pending waiters so they don't hang
    for (const { reject } of this._waiters) {
      reject(new Error('Browser pool shutting down'));
    }
    this._waiters = [];

    // Close all contexts before browsers
    for (const context of this.availableContexts) {
      await context.close().catch(() => {});
    }
    this.availableContexts = [];

    // Close browsers
    for (const browser of this.browsers) {
      await browser.close().catch(() => {});
    }
    this.browsers = [];
  }
}
