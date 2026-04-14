/**
 * Arco Recommender — Cloudflare Worker
 * Streams AI-generated EDS page content as NDJSON.
 * Uses Cerebras for LLM inference, Cloudflare Vectorize for RAG.
 */

import { persistAndPublish, buildPageHtml, unescapeHtml } from './da-persist.js';
import { createContext } from './pipeline/context.js';
import { executeFlow } from './pipeline/executor.js';
import { resolveFlow } from './pipeline/flows.js';
import { STEPS } from './pipeline/steps/index.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Loadtest-Token',
};

/**
 * Main handler: streams NDJSON sections via composable pipeline steps.
 */
async function handleGenerate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const { query } = body;
  if (!query || typeof query !== 'string' || query.length > 500) {
    return new Response(JSON.stringify({ error: 'Invalid query' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const ctx = createContext(body, request);
  const flow = resolveFlow(body.flow);
  ctx.flowId = flow.id;
  ctx.flowName = flow.name || flow.id;

  // Run gate steps before streaming
  if (!ctx.timings.steps) ctx.timings.steps = [];
  const gateSteps = flow.steps.filter((s) => s.gate);
  // eslint-disable-next-line no-plusplus
  for (let gi = 0; gi < gateSteps.length; gi++) {
    if (ctx.earlyResponse) break;
    const s = gateSteps[gi];
    const gateStart = Date.now();
    // eslint-disable-next-line no-await-in-loop
    await STEPS[s.step](ctx, s.config || {}, env);
    ctx.timings.steps.push({
      step: s.step, ms: Date.now() - gateStart, gate: true,
    });
  }
  if (ctx.earlyResponse) return ctx.earlyResponse;

  // Set up streaming
  const { readable, writable } = new TransformStream();
  ctx.writer = writable.getWriter();
  ctx.encoder = new TextEncoder();
  const remaining = flow.steps.filter((s) => !s.gate);

  const streamPromise = (async () => {
    try {
      await executeFlow(remaining, ctx, env);
    } catch (err) {
      const errorLine = JSON.stringify({ type: 'error', message: err.message || 'Generation failed' });
      await ctx.writer.write(ctx.encoder.encode(`${errorLine}\n`));
    } finally {
      await ctx.writer.close();
    }
  })();

  request.ctx?.waitUntil?.(streamPromise);
  if (!request.ctx) {
    streamPromise.catch(() => {});
  }

  return new Response(readable, {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    },
  });
}

/**
 * Handle page persistence to DA.
 */
async function handlePersist(request, env) {
  try {
    const body = await request.json();
    const {
      query, blocks, title, pageId,
    } = body;

    if (!query || !blocks || blocks.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Missing query or blocks' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
      );
    }

    const base = '/discover';
    const id = pageId || crypto.randomUUID().slice(0, 8);
    const path = `${base}/${id}`;

    let pageTitle = title || '';
    if (!pageTitle) {
      const firstH1 = blocks.reduce((found, block) => {
        if (found) return found;
        const html = typeof block === 'string' ? block : block.html;
        const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
        return h1Match ? h1Match[1] : null;
      }, null);
      pageTitle = firstH1 ? unescapeHtml(firstH1) : '';
    }
    pageTitle = pageTitle || 'Your Arco Recommendation';

    const pageDescription = `Personalized Arco content for: ${query}`;
    const html = buildPageHtml(pageTitle, pageDescription, blocks);

    console.log(`[Persist] Saving page to ${path}`);
    const result = await persistAndPublish(path, html, env);

    if (!result.success) {
      console.error(`[Persist] Failed: ${result.error}`);
      return new Response(
        JSON.stringify({ success: false, error: result.error }),
        { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
      );
    }

    console.log(`[Persist] Success: ${result.urls?.live}`);
    return new Response(
      JSON.stringify({ success: true, path, urls: result.urls }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    console.error('[Persist] Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
    );
  }
}

export default {
  async fetch(request, env, ctx) {
    request.ctx = ctx;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/generate' && request.method === 'POST') {
      return handleGenerate(request, env);
    }

    if (url.pathname === '/api/persist' && request.method === 'POST') {
      return handlePersist(request, env);
    }

    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  },
};
