/**
 * Browsing Signal Collector & Local Intent Classifier
 *
 * Passively collects navigation, engagement, and interaction signals
 * on regular (non-recommender) pages, classifies intent locally using
 * lightweight rules, and feeds context into the session so subsequent
 * recommender queries are better informed.
 *
 * Loaded in the delayed phase — zero impact on LCP.
 *
 * NOTE — "intent" overloading: the project has three distinct notions of intent,
 * all unrelated:
 *   1. THIS file — rule-based path intent ('product-detail', 'discovery', …)
 *      emitted per page view into the session browsing history.
 *   2. workers/recommender/src/pipeline/steps/intent-classify.js — keyword-based
 *      query intent ('espresso', 'comparison', …) classified server-side and
 *      written to ctx.intent.
 *   3. D1 generated_pages.intent_type column — persisted form of (2).
 * Keep them distinct when reading admin output or debug payloads.
 */

import { SessionContextManager } from './session-context.js';

const MAX_SIGNALS = 20;
const ENGAGEMENT_THRESHOLD_MS = 5000;
const DEEP_ENGAGEMENT_MS = 30000;
const SCROLL_THROTTLE_MS = 500;

/* ========================================================================== */
/*  Path-based intent rules                                                    */
/* ========================================================================== */

const PATH_RULES = [
  { pattern: /^\/products\/espresso-machines\/[^/]+/, intent: 'product-detail', stage: 'comparing' },
  { pattern: /^\/products\/grinders\/[^/]+/, intent: 'product-detail', stage: 'comparing' },
  { pattern: /^\/products\/espresso-machines\/?$/, intent: 'discovery', stage: 'exploring' },
  { pattern: /^\/products\/grinders\/?$/, intent: 'discovery', stage: 'exploring' },
  { pattern: /^\/products\/accessories/, intent: 'discovery', stage: 'exploring' },
  { pattern: /^\/products\/?$/, intent: 'discovery', stage: 'exploring' },
  { pattern: /^\/stories\//, intent: 'technique', stage: 'exploring' },
  { pattern: /^\/experiences\//, intent: 'use-case', stage: 'exploring' },
  { pattern: /^\/about/, intent: 'discovery', stage: 'exploring' },
  { pattern: /^\/support/, intent: 'support', stage: 'deciding' },
  { pattern: /^\/warranty/, intent: 'support', stage: 'deciding' },
];

/* ========================================================================== */
/*  Signal collection                                                          */
/* ========================================================================== */

let scrollDepth = 0;
let scrollRAF = null;
let pageLoadTime = Date.now();

function getBlockNames() {
  return [...document.querySelectorAll('[data-block-name]')]
    .map((el) => el.dataset.blockName);
}

function getPageSignal() {
  const { pathname } = window.location;
  return {
    type: 'page',
    path: pathname,
    timestamp: Date.now(),
    data: {
      title: document.title,
      blocks: getBlockNames(),
      theme: document.body.dataset.theme || '',
    },
  };
}

function trackScrollDepth() {
  if (scrollRAF) return;
  scrollRAF = requestAnimationFrame(() => {
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    if (docHeight > 0) {
      const pct = Math.round((window.scrollY / docHeight) * 100);
      if (pct > scrollDepth) scrollDepth = pct;
    }
    scrollRAF = null;
  });
}

function getEngagementSignal() {
  const timeSpent = Math.round((Date.now() - pageLoadTime) / 1000);
  return {
    type: 'engagement',
    path: window.location.pathname,
    timestamp: Date.now(),
    data: {
      timeSpent,
      scrollDepth,
    },
  };
}

/* ========================================================================== */
/*  Interaction listeners                                                      */
/* ========================================================================== */

function setupInteractionListeners(addSignal) {
  // Quiz answers
  document.addEventListener('click', (e) => {
    const quizBtn = e.target.closest('.quiz .button, .quiz button');
    if (quizBtn) {
      addSignal({
        type: 'interaction',
        path: window.location.pathname,
        timestamp: Date.now(),
        data: {
          action: 'quiz-answer',
          value: quizBtn.textContent.trim(),
        },
      });
    }
  });

  // Product list filters
  document.addEventListener('change', (e) => {
    const filter = e.target.closest('.product-list select, .product-list input');
    if (filter) {
      addSignal({
        type: 'interaction',
        path: window.location.pathname,
        timestamp: Date.now(),
        data: {
          action: 'filter',
          value: filter.value || filter.textContent?.trim(),
        },
      });
    }
  });

  // Tab switches
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.tabs button');
    if (tab) {
      addSignal({
        type: 'interaction',
        path: window.location.pathname,
        timestamp: Date.now(),
        data: {
          action: 'tab-switch',
          value: tab.textContent.trim(),
        },
      });
    }
  });

  // Video plays
  document.addEventListener('play', (e) => {
    if (e.target.tagName === 'VIDEO') {
      addSignal({
        type: 'interaction',
        path: window.location.pathname,
        timestamp: Date.now(),
        data: { action: 'video-play' },
      });
    }
  }, true);
}

/* ========================================================================== */
/*  Local intent classifier                                                    */
/* ========================================================================== */

function extractProductSlug(path) {
  const match = path.match(/\/products\/(?:espresso-machines|grinders)\/([^/]+)/);
  return match ? match[1] : null;
}

function extractCategory(path) {
  const match = path.match(/\/products\/([^/]+)/);
  return match ? match[1] : null;
}

function classifyFromPath(pathname) {
  const matched = PATH_RULES.find((rule) => rule.pattern.test(pathname));
  if (matched) return { intent: matched.intent, stage: matched.stage };
  return { intent: 'discovery', stage: 'exploring' };
}

/**
 * Build the inferred profile from accumulated signals.
 */
function buildInferredProfile(signals) {
  const productsViewed = [];
  const categoriesViewed = new Set();
  const contentTypes = new Set();
  const interests = [];
  const quizAnswers = {};
  let totalTimeOnSite = 0;

  signals.forEach((signal) => {
    if (signal.type === 'page') {
      const slug = extractProductSlug(signal.path);
      if (slug && !productsViewed.includes(slug)) {
        productsViewed.push(slug);
      }
      const cat = extractCategory(signal.path);
      if (cat) categoriesViewed.add(cat);

      const { intent } = classifyFromPath(signal.path);
      contentTypes.add(intent);
    }

    if (signal.type === 'engagement') {
      totalTimeOnSite += signal.data.timeSpent || 0;
    }

    if (signal.type === 'interaction') {
      if (signal.data.action === 'quiz-answer') {
        quizAnswers[`answer-${Object.keys(quizAnswers).length + 1}`] = signal.data.value;
      }
      if (signal.data.action === 'filter') {
        interests.push(signal.data.value);
      }
    }
  });

  // Determine journey stage from browsing patterns
  let journeyStage = 'exploring';
  if (productsViewed.length >= 3) {
    journeyStage = 'deciding';
  } else if (productsViewed.length >= 2) {
    journeyStage = 'comparing';
  }

  // Determine inferred intent from the dominant content types
  let inferredIntent = 'discovery';
  if (productsViewed.length >= 2) {
    inferredIntent = 'comparison';
  } else if (productsViewed.length === 1) {
    inferredIntent = 'product-detail';
  } else if (contentTypes.has('technique')) {
    inferredIntent = 'technique';
  } else if (contentTypes.has('use-case')) {
    inferredIntent = 'use-case';
  }

  return {
    productsViewed,
    categoriesViewed: [...categoriesViewed],
    contentTypes: [...contentTypes],
    inferredIntent,
    journeyStage,
    interests: [...new Set(interests)],
    quizAnswers: Object.keys(quizAnswers).length > 0 ? quizAnswers : undefined,
    pagesVisited: signals.filter((s) => s.type === 'page').length,
    totalTimeOnSite,
  };
}

/* ========================================================================== */
/*  Main entry point                                                           */
/* ========================================================================== */

/**
 * Start passive browsing signal collection.
 * Call this from delayed.js so it has zero LCP impact.
 */
export function collectBrowsingSignals() {
  // Skip on recommender pages — they have their own tracking
  const params = new URLSearchParams(window.location.search);
  if (params.has('q') || params.has('query')) return;

  // Skip cached recommender pages served from DA
  if (window.location.pathname.startsWith('/discover/')) return;

  const signals = [];
  pageLoadTime = Date.now();
  scrollDepth = 0;

  function addSignal(signal) {
    signals.push(signal);
    if (signals.length > MAX_SIGNALS) signals.shift();

    const profile = buildInferredProfile(signals);
    SessionContextManager.updateInferredProfile(profile);
    window.dispatchEvent(new CustomEvent('arco-context-updated', {
      detail: { signalType: signal.type, profile },
    }));
  }

  // Record the page visit before firing signals so arco-context-updated
  // reflects the updated browsingHistory count (needed for "For You" link visibility).
  const { intent, stage } = classifyFromPath(window.location.pathname);
  SessionContextManager.addPageVisit({
    path: window.location.pathname,
    title: document.title,
    blocks: getBlockNames(),
    intent,
    stage,
    timestamp: Date.now(),
  });

  // 1. Page signal — immediate
  const pageSignal = getPageSignal();
  addSignal(pageSignal);

  // 2. Scroll depth tracking
  let scrollThrottled = false;
  window.addEventListener('scroll', () => {
    if (scrollThrottled) return;
    scrollThrottled = true;
    setTimeout(() => { scrollThrottled = false; }, SCROLL_THROTTLE_MS);
    trackScrollDepth();
  }, { passive: true });

  // 3. Engagement signal — after threshold
  setTimeout(() => {
    addSignal(getEngagementSignal());
  }, ENGAGEMENT_THRESHOLD_MS);

  // 4. Deep engagement tracking
  setTimeout(() => {
    addSignal(getEngagementSignal());
  }, DEEP_ENGAGEMENT_MS);

  // 5. Capture final engagement on page leave.
  //    Transport moved to analytics-events.js — it runs on every page (this
  //    collector skips /discover/ and ?q=) and batches events, so emitting a
  //    beacon here too would double-count page views.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;

    const engagement = getEngagementSignal();
    addSignal(engagement);
    SessionContextManager.updateLastPageVisit({
      timeSpent: engagement.data.timeSpent,
      scrollDepth: engagement.data.scrollDepth,
    });
  });

  // 6. Interaction listeners
  setupInteractionListeners(addSignal);
}

export default collectBrowsingSignals;
