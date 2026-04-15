/**
 * HTTP-mode tester — hits the worker /api/generate endpoint directly with fetch().
 * No browser involved. Use to isolate worker/network overhead from Playwright overhead.
 *
 * Usage: --mode http  (--skip-pipeline recommended for a pure infrastructure baseline)
 */

/**
 * Simple counting semaphore for concurrency control without a browser pool.
 */
export class Semaphore {
  constructor(max) {
    this.max = max;
    this.count = 0;
    this._waiters = [];
  }

  async acquire() {
    if (this.count < this.max) {
      this.count++;
      return;
    }
    await new Promise((resolve) => { this._waiters.push(resolve); });
  }

  release() {
    if (this._waiters.length > 0) {
      this._waiters.shift()();
    } else {
      this.count--;
    }
  }
}

/**
 * Run a single query against the worker API directly via fetch().
 * Returns the same result shape as testSingleQuery() so Reporter works unchanged.
 */
export async function testSingleQueryHTTP(prompt, config) {
  const result = {
    id: prompt.id,
    query: prompt.query,
    category: prompt.category,
    startTime: Date.now(),
    timestamps: {},
    status: 'pending',
    error: null,
    errorSource: null,
    consoleLogs: [],
    screenshotPath: null,
    sectionCount: 0,
    pageTitle: null,
    serverReportedTime: null,
    serverTimings: null,
    totalDuration: null,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout);

  try {
    result.timestamps.navigationStart = Date.now();

    const headers = { 'Content-Type': 'application/json' };
    if (config.loadtestToken) headers['x-loadtest-token'] = config.loadtestToken;
    if (config.skipCerebras) headers['x-skip-cerebras'] = 'true';
    if (config.skipPipeline) headers['x-skip-pipeline'] = 'true';

    const response = await fetch(`${config.workerUrl}/api/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: prompt.query }),
      signal: controller.signal,
    });

    result.timestamps.domContentLoaded = Date.now();
    result.httpStatus = response.status;

    if (response.status === 429) {
      result.apiStatus = 429;
      throw new Error('429 rate limit');
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    // Stream and parse NDJSON
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue; // eslint-disable-line no-continue
        let msg;
        try { msg = JSON.parse(line); } catch { continue; } // eslint-disable-line no-continue

        if (msg.type === 'section') {
          if (!result.timestamps.firstSection) result.timestamps.firstSection = Date.now();
          result.sectionCount += 1;
        } else if (msg.type === 'suggestions') {
          result.timestamps.streamComplete = Date.now();
        } else if (msg.type === 'done') {
          result.pageTitle = msg.title || null;
        } else if (msg.type === 'debug' && msg.timings) {
          result.serverTimings = msg.timings;
          if (msg.timings.total) result.serverReportedTime = msg.timings.total / 1000;
        } else if (msg.type === 'error') {
          throw new Error(msg.message || 'Worker error');
        }
      }
    }

    result.status = 'success';
  } catch (err) {
    result.status = 'error';
    result.error = err.message;

    const e = err.message.toLowerCase();
    if (e.includes('ai service') || e.includes('ai rate limit') || e.includes('ai request timed out')) {
      result.errorSource = 'cerebras';
    } else if (e.includes('429') || e.includes('rate limit')) {
      result.errorSource = 'worker';
    } else if (result.httpStatus >= 500) {
      result.errorSource = 'worker';
    } else if (e.includes('abort') || e.includes('timeout')) {
      result.errorSource = 'client';
    } else if (e.includes('fetch') || e.includes('econnrefused') || e.includes('econnreset')) {
      result.errorSource = 'network';
    } else {
      result.errorSource = 'unknown';
    }
  } finally {
    clearTimeout(timeoutId);
    result.endTime = Date.now();
    result.totalDuration = result.endTime - result.startTime;
  }

  return result;
}
