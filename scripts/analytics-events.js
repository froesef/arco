/**
 * Marketing event tracker.
 *
 * Batches behavioural events and ships them to the recommender worker's
 * /api/track endpoint, which dual-sinks to Workers Analytics Engine (sampled
 * traffic trends) and D1 (exact, attributable funnel data).
 *
 * Runs on *every* page — unlike browsing-signals.js, which deliberately skips
 * recommender and /discover/ pages. Conversions happen on product pages that a
 * generated page referred to, so the attribution chain must span both.
 *
 * Attribution model: when a user clicks a product link inside a generated
 * page, we stash that run id in sessionStorage. Any product_view or
 * add_to_cart within ATTRIBUTION_WINDOW_MS credits that run. Last touch wins.
 * The server re-validates the id against generated_pages before trusting it.
 */

import { ARCO_ANALYTICS_URL } from './api-config.js';
import { SessionContextManager } from './session-context.js';

const ATTRIBUTION_KEY = 'arco-attribution';
const ATTRIBUTION_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const FLUSH_AT = 10;
const FLUSH_INTERVAL_MS = 15000;

const queue = [];
let flushTimer = null;
let listenersBound = false;
let pageLoadTime = Date.now();
let maxScrollPct = 0;

/* ========================================================================== */
/*  Attribution                                                                */
/* ========================================================================== */

/**
 * Record that the user departed a generated page via a product link.
 * @param {string} runId
 * @param {string} [productSlug]
 */
export function setAttribution(runId, productSlug) {
  if (!runId) return;
  try {
    window.sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify({
      runId,
      productSlug: productSlug || null,
      ts: Date.now(),
    }));
  } catch { /* sessionStorage unavailable — attribution degrades to none */ }
}

/**
 * Read the current attribution if it hasn't expired.
 * @returns {{runId: string, productSlug: string|null, ts: number}|null}
 */
export function getAttribution() {
  try {
    const raw = window.sessionStorage.getItem(ATTRIBUTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.runId) return null;
    if (Date.now() - parsed.ts > ATTRIBUTION_WINDOW_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The run id of the generated page currently being viewed, if any.
 * @returns {string|null}
 */
function currentRunId() {
  const el = document.querySelector('[data-run-id]');
  return el?.dataset.runId || null;
}

/* ========================================================================== */
/*  Queue + transport                                                          */
/* ========================================================================== */

function sessionId() {
  try {
    return SessionContextManager.getSessionId();
  } catch {
    return null;
  }
}

/**
 * Send everything currently queued. Uses sendBeacon so it survives unload;
 * falls back to a keepalive fetch where sendBeacon is unavailable.
 */
export function flush() {
  if (!queue.length) return;

  const events = queue.splice(0, queue.length);
  const url = window.ARCO_CONFIG?.ANALYTICS_URL || ARCO_ANALYTICS_URL;
  if (!url) return;

  const payload = JSON.stringify({ sessionId: sessionId(), events });

  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' });
      if (navigator.sendBeacon(`${url}/api/track`, blob)) return;
    }
    fetch(`${url}/api/track`, {
      method: 'POST',
      body: payload,
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
    }).catch(() => { /* best effort */ });
  } catch { /* never let telemetry break the page */ }
}

/**
 * Queue one event.
 * @param {string} eventType One of the types the worker allow-lists.
 * @param {object} [payload] Extra fields (path, productSlug, valueCents, …).
 */
export function track(eventType, payload = {}) {
  if (!eventType) return;

  const attribution = getAttribution();
  const runId = currentRunId();

  queue.push({
    eventType,
    sessionId: sessionId(),
    pageId: window.ARCO_PAGE_ID || null,
    runId,
    // A generated page attributes to itself; downstream pages use the stash.
    attributedRunId: runId || attribution?.runId || null,
    path: window.location.pathname,
    referrerPath: document.referrer
      ? (() => {
        try { return new URL(document.referrer).pathname; } catch { return null; }
      })()
      : null,
    timestamp: Date.now(),
    ...payload,
  });

  if (queue.length >= FLUSH_AT) flush();
  else if (!flushTimer) {
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_INTERVAL_MS);
  }
}

/* ========================================================================== */
/*  Automatic instrumentation                                                  */
/* ========================================================================== */

/**
 * Parse a price string ("$1,299.00", "1.299,00 €") into integer cents.
 * @param {string} text
 * @returns {number|null}
 */
export function parsePriceCents(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/[^0-9.,]/g, '').trim();
  if (!cleaned) return null;

  // Whichever separator appears last is the decimal separator.
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalised;
  if (lastComma > lastDot) {
    normalised = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    normalised = cleaned.replace(/,/g, '');
  }

  const value = parseFloat(normalised);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/**
 * Slug from a product URL path.
 * @param {string} path
 * @returns {string|null}
 */
export function productSlugFromPath(path) {
  const m = (path || '').match(/^\/products\/[^/]+\/([^/?#]+)/);
  return m ? m[1] : null;
}

function trackScroll() {
  const docHeight = document.documentElement.scrollHeight - window.innerHeight;
  if (docHeight <= 0) return;
  const pct = Math.round((window.scrollY / docHeight) * 100);
  if (pct > maxScrollPct) maxScrollPct = Math.min(100, pct);
}

/**
 * One delegated click handler for the whole document — no per-block wiring,
 * so new blocks are instrumented for free.
 */
function handleClick(event) {
  const anchor = event.target.closest?.('a[href]');
  const button = event.target.closest?.('button');

  if (anchor) {
    let path;
    try {
      path = new URL(anchor.href, window.location.origin).pathname;
    } catch {
      return;
    }

    const slug = productSlugFromPath(path);
    const inGenerated = anchor.closest('[data-run-id]');

    if (slug) {
      // Clicked through to a product — set up attribution for the landing page.
      const runId = inGenerated?.dataset.runId || getAttribution()?.runId;
      if (runId) setAttribution(runId, slug);
      if (inGenerated) {
        track('product_card_click', { productSlug: slug, path });
        flush(); // navigation is imminent
        return;
      }
    }

    if (anchor.classList.contains('button') || anchor.closest('.button-container')) {
      track('cta_click', { path });
    }
    return;
  }

  if (button && button.closest('.follow-up-container')) {
    track('follow_up_click', {
      label: (button.textContent || '').trim().substring(0, 120),
    });
  }
}

/**
 * Emit the engagement summary describing how this page was consumed.
 * Guarded — visibilitychange and pagehide both fire on most unload paths.
 */
let summarySent = false;
function sendPageSummary() {
  if (summarySent) return;
  summarySent = true;
  const dwellMs = Date.now() - pageLoadTime;
  track('engagement', { dwellMs, scrollPct: maxScrollPct });
  flush();
}

/**
 * Start tracking. Idempotent.
 */
export function initEventTracking() {
  if (listenersBound) return;
  listenersBound = true;
  pageLoadTime = Date.now();

  const path = window.location.pathname;
  const slug = productSlugFromPath(path);

  // Soft conversion — a product detail page was actually viewed.
  if (slug) {
    const priceEl = document.querySelector('.product-detail-price');
    track('product_view', {
      productSlug: slug,
      valueCents: parsePriceCents(priceEl?.textContent || ''),
    });
  } else {
    track('page_view', {});
  }

  document.addEventListener('click', handleClick, { capture: true, passive: true });
  window.addEventListener('scroll', trackScroll, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') sendPageSummary();
    else summarySent = false; // returned to the tab — allow a fresh summary
  });
  window.addEventListener('pagehide', sendPageSummary);
}

export default initEventTracking;
