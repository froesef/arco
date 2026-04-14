/**
 * Rate Limit Step — checks request rate against KV counter.
 * Sets ctx.earlyResponse (429) if limit exceeded.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, X-Loadtest-Token',
};

const DEFAULT_WINDOW = 60;
const DEFAULT_MAX = 30;

// eslint-disable-next-line import/prefer-default-export
export async function rateLimit(ctx, config, env) {
  if (!env.CACHE || env.ENVIRONMENT === 'development') return;

  // Allow bypass with X-Loadtest-Token header (for load testing only)
  if (env.LOADTEST_TOKEN) {
    const token = ctx.request.headers?.get('x-loadtest-token');
    if (token && token === env.LOADTEST_TOKEN) return;
  }

  const key = `rate:${ctx.request.ip}`;
  const current = await env.CACHE.get(key);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= (config.max || DEFAULT_MAX)) {
    ctx.earlyResponse = new Response(
      JSON.stringify({ error: 'Rate limit exceeded. Try again in a minute.' }),
      { status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
    );
    return;
  }

  await env.CACHE.put(key, String(count + 1), {
    expirationTtl: config.window || DEFAULT_WINDOW,
  });
}
