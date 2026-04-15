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
    parallel, headless, viewportWidth, viewportHeight, loadtestToken, skipCerebras, skipPipeline,
  }) {
    this.parallel = parallel;
    this.headless = headless;
    this.viewportWidth = viewportWidth;
    this.viewportHeight = viewportHeight;
    this.loadtestToken = loadtestToken || '';
    this.skipCerebras = skipCerebras || false;
    this.skipPipeline = skipPipeline || false;

    this.browsers = [];
    this.availableContexts = [];
    this._waiters = [];
  }

  async initialize() {
    const browserCount = Math.max(1, Math.ceil(this.parallel / MAX_CONTEXTS_PER_BROWSER));
    const contextsPerBrowser = Math.ceil(this.parallel / browserCount);
    const needsRouting = this.loadtestToken || this.skipCerebras || this.skipPipeline;

    console.log(
      `[browser-pool] Launching ${browserCount} browser(s) in parallel `
      + `with ${contextsPerBrowser} contexts each (${this.parallel} total)`,
    );

    // Launch all browsers in parallel
    this.browsers = await Promise.all(
      Array.from({ length: browserCount }, () => chromium.launch({ headless: this.headless })),
    );

    // Create all contexts in parallel across all browsers
    const allContextPromises = this.browsers.flatMap((browser, b) => {
      const alreadyCreated = b * contextsPerBrowser;
      const count = Math.min(contextsPerBrowser, this.parallel - alreadyCreated);
      return Array.from({ length: count }, async () => {
        const context = await browser.newContext({
          viewport: { width: this.viewportWidth, height: this.viewportHeight },
          ignoreHTTPSErrors: true,
        });
        if (needsRouting) {
          await context.route('**/api/generate', (route) => {
            const headers = { ...route.request().headers() };
            if (this.loadtestToken) headers['x-loadtest-token'] = this.loadtestToken;
            if (this.skipCerebras) headers['x-skip-cerebras'] = 'true';
            if (this.skipPipeline) headers['x-skip-pipeline'] = 'true';
            route.continue({ headers });
          });
        }
        return context;
      });
    });

    this.availableContexts = await Promise.all(allContextPromises);
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
