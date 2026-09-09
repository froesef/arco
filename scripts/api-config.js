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

/**
 * Resolve the recommender worker URL for the current environment.
 *
 * Priority:
 *   1. window.ARCO_CONFIG.RECOMMENDER_URL  — explicit global override
 *   2. localStorage['arco-recommender-url'] — runtime toggle, no code edit:
 *        localStorage.setItem('arco-recommender-url', 'http://localhost:8787')
 *        localStorage.removeItem('arco-recommender-url')             // back to default
 *   3. {branch}--{repo}--{owner}.aem.page → that branch's worker version
 *   4. everything else (including localhost) → production
 *
 * Localhost deliberately defaults to PRODUCTION. `wrangler dev` cannot bind
 * Vectorize ("Vectorize Index bindings do not support local development"), so a
 * local worker silently returns empty RAG context and generates hollow pages.
 * Opt into the local worker explicitly via option 2 when you are working on the
 * worker itself.
 */
function resolveRecommenderURL() {
  if (window.ARCO_CONFIG?.RECOMMENDER_URL) return window.ARCO_CONFIG.RECOMMENDER_URL;

  try {
    const stored = window.localStorage?.getItem('arco-recommender-url');
    if (stored) return stored;
  } catch { /* localStorage may be unavailable (private mode / sandbox) */ }

  const { hostname } = window.location;

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

/**
 * Admin/metrics API base.
 *
 * Split from the recommender URL on purpose: the admin dashboards read D1 and KV
 * directly, so when you are developing them you want your *local* worker and its
 * local database, even while the page-generation flow keeps hitting production
 * (which is the only place Vectorize actually works).
 *
 * Override with localStorage['arco-admin-url'], or set it to the production
 * worker to inspect real traffic from a local admin page.
 */
function resolveAdminURL() {
  if (window.ARCO_CONFIG?.ADMIN_URL) return window.ARCO_CONFIG.ADMIN_URL;

  try {
    const stored = window.localStorage?.getItem('arco-admin-url');
    if (stored) return stored;
  } catch { /* localStorage may be unavailable (private mode / sandbox) */ }

  const { hostname } = window.location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return 'http://localhost:8787';

  return ARCO_RECOMMENDER_URL;
}

export const ARCO_ADMIN_URL = resolveAdminURL();

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
