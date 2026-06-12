/**
 * Arco - API Configuration (Cloudflare Worker)
 *
 * Central configuration for all API endpoints.
 * Recommender runs on Cloudflare Workers with Cerebras LLM inference.
 */

// ============================================
// Cloudflare Worker Endpoints
// ============================================

const PRODUCTION_WORKER = 'https://arco-recommender.franklin-prod.workers.dev';

// Local `wrangler dev` worker (run `npm run dev` in workers/recommender).
// Wrangler picks 8787 by default but increments when ports are taken; this repo's
// dev worker comes up on 8789. Override via the mechanisms below if yours differs.
const LOCAL_WORKER = 'http://localhost:8789';

/**
 * Resolve the recommender worker URL for the current environment.
 *
 * Priority:
 *   1. window.ARCO_CONFIG.RECOMMENDER_URL  — explicit global override
 *   2. localStorage['arco-recommender-url'] — runtime toggle, no code edit:
 *        localStorage.setItem('arco-recommender-url', 'http://localhost:8787')
 *        localStorage.setItem('arco-recommender-url', '<prod url>')  // force prod locally
 *        localStorage.removeItem('arco-recommender-url')             // back to default
 *   3. localhost / 127.0.0.1 → the local `wrangler dev` worker (LOCAL_WORKER)
 *   4. {branch}--{repo}--{owner}.aem.page → that branch's worker version
 *   5. everything else → production
 */
function resolveRecommenderURL() {
  if (window.ARCO_CONFIG?.RECOMMENDER_URL) return window.ARCO_CONFIG.RECOMMENDER_URL;

  try {
    const stored = window.localStorage?.getItem('arco-recommender-url');
    if (stored) return stored;
  } catch { /* localStorage may be unavailable (private mode / sandbox) */ }

  const { hostname } = window.location;

  // Local dev: point at the local worker so /api/generate uses locally-served
  // models (e.g. DiffusionGemma via mlx-vlm). Override via the above to use prod.
  if (hostname === 'localhost' || hostname === '127.0.0.1') return LOCAL_WORKER;

  // EDS branch preview: rewrite to the branch alias worker version.
  const match = hostname.match(/^(.+)--[^.]+--[^.]+\.aem\.page$/);
  if (!match || match[1] === 'main') return PRODUCTION_WORKER;

  const alias = match[1]
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return `https://${alias}-arco-recommender.franklin-prod.workers.dev`;
}

// Main recommender service (Cloudflare Worker)
export const ARCO_RECOMMENDER_URL = resolveRecommenderURL();

// Analytics service — same worker, separate endpoint
export const ARCO_ANALYTICS_URL = window.ARCO_CONFIG?.ANALYTICS_URL || ARCO_RECOMMENDER_URL;

// ============================================
// Environment Detection
// ============================================

export const IS_PRODUCTION = !window.location.hostname.includes('localhost')
  && !window.location.hostname.includes('preview');

export const IS_LOCAL = window.location.hostname.includes('localhost');

// ============================================
// Configuration Helper
// ============================================

/**
 * Get the appropriate API endpoint for the current environment.
 * Accepts an optional service name argument (currently only 'recommender' exists).
 */
export function getAPIEndpoint() {
  return ARCO_RECOMMENDER_URL;
}

/**
 * Log API configuration on page load
 */
if (IS_LOCAL) {
  // eslint-disable-next-line no-console
  console.log('[Arco] API Configuration:', {
    recommender: ARCO_RECOMMENDER_URL,
    environment: IS_PRODUCTION ? 'production' : 'development',
  });
}
