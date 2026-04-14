/**
 * Client-side rate limiter for pacing requests.
 *
 * Two modes:
 * - Steady drip (rate <= 1): classic token bucket, one token every 1/rate seconds
 * - Burst-then-wait (rate > 1): send up to 28 requests fast, wait for the 60s
 *   KV TTL window to expire, repeat
 */

const BURST_LIMIT = 28; // stay under the server's 30/60s with a 2-request margin
const WINDOW_MS = 61_000; // 61s to be safe against clock drift

export class RateLimiter {
  constructor(ratePerSecond, { bypassServerLimit = false } = {}) {
    this.rate = ratePerSecond;
    this.bypass = bypassServerLimit;
    this.burstMode = !bypassServerLimit && ratePerSecond > 1;

    // Stats
    this.sent = 0;
    this.throttled = 0;
    this.backoffs = 0;

    if (this.burstMode) {
      this.windowStart = null;
      this.windowCount = 0;
    }
    // Steady drip: used when rate <= 1, or when bypass is active (no burst needed)
    this.intervalMs = 1000 / ratePerSecond;
    this.lastRelease = 0;

    this._backingOff = false;
    this._backoffPromise = null;
  }

  async acquire() {
    // Wait for any active backoff
    if (this._backoffPromise) {
      await this._backoffPromise;
    }

    if (this.burstMode && !this.bypass) {
      await this._acquireBurst();
    } else {
      await this._acquireSteady();
    }

    this.sent++;
  }

  async _acquireSteady() {
    const now = Date.now();
    const elapsed = now - this.lastRelease;
    if (elapsed < this.intervalMs) {
      const wait = this.intervalMs - elapsed;
      this.throttled++;
      await sleep(wait);
    }
    this.lastRelease = Date.now();
  }

  async _acquireBurst() {
    const now = Date.now();

    // Start a new window if none exists or the current one expired
    if (this.windowStart === null || (now - this.windowStart) >= WINDOW_MS) {
      this.windowStart = now;
      this.windowCount = 0;
    }

    // If we've hit the burst limit, wait for the window to expire
    if (this.windowCount >= BURST_LIMIT) {
      const remaining = WINDOW_MS - (now - this.windowStart);
      if (remaining > 0) {
        this.throttled++;
        const nextWindow = this.windowCount;
        console.error(
          `[rate-limiter] Burst limit reached (${nextWindow}/${BURST_LIMIT}), `
          + `waiting ${Math.ceil(remaining / 1000)}s for window reset`,
        );
        await sleep(remaining);
      }
      this.windowStart = Date.now();
      this.windowCount = 0;
    }

    this.windowCount++;
  }

  record429() {
    this.backoffs++;
    if (!this._backingOff) {
      this._backingOff = true;
      console.error('[rate-limiter] 429 received — backing off 60s');
      this._backoffPromise = sleep(60_000).then(() => {
        this._backingOff = false;
        this._backoffPromise = null;
        // Reset burst window after backoff
        if (this.burstMode) {
          this.windowStart = null;
          this.windowCount = 0;
        }
      });
    }
  }

  getStats() {
    return {
      sent: this.sent,
      throttled: this.throttled,
      backoffs: this.backoffs,
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
