/**
 * Arco Recommender — Cloudflare Worker
 * Streams AI-generated EDS page content as NDJSON.
 * Uses Cerebras for LLM inference, Cloudflare Vectorize for RAG.
 */

import { persistAndPublish, buildPageHtml, unescapeHtml } from './da-persist.js';
import { createContext, CORS_HEADERS } from './pipeline/context.js';
import { executeFlow } from './pipeline/executor.js';
import { resolveFlow } from './pipeline/flows.js';
import { STEPS } from './pipeline/steps/index.js';
import { writeEvent, classifyPageType, queryStats } from './analytics.js';
import { saveGeneration } from './storage.js';
import { parseGenerateBody } from './request-schema.js';
import {
  handleAdminSessions,
  handleAdminSession,
  handleAdminPageGroup,
  handleAdminRun,
  handleAdminUI,
  handleAdminCatalog,
  handleAdminLlmConfigGet,
  handleAdminLlmConfigPut,
} from './admin.js';
import {
  handleVectorizeStats,
  handleVectorizeSearch,
  handleVectorizeItem,
} from './vectorize-admin.js';
import {
  handleCreateExperiment,
  handleListExperiments,
  handleGetExperiment,
  handleGetExperimentVariant,
} from './experiments.js';
import {
  handleListEvalSuites,
  handleCreateEvaluation,
  handleRunEvalQuery,
  handleFinalizeEvaluation,
  handleListEvaluations,
  handleGetEvaluation,
  handleJudgeEvaluation,
  handleRejudgeVariant,
  handleRegenerateVariant,
} from './evaluations/admin.js';
import handleSuggestRequest from './suggest.js';

/**
 * Full pipeline bypass for load testing — skips rate-limit, RAG, intent, and LLM.
 * Activated by X-Skip-Pipeline header. Returns dummy NDJSON immediately.
 */
async function streamDummyPipeline(request) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const streamPromise = (async () => {
    try {
      const sections = [
        '<div class="section"><h1>Load test dummy page</h1><p>Pipeline bypassed — no RAG or LLM called.</p></div>',
        '<div class="section"><h2>About this product</h2><p>Dummy content for throughput testing.</p></div>',
        '<div class="section"><h2>Key features</h2><ul><li>Fast</li><li>Reliable</li><li>Scalable</li></ul></div>',
      ];
      for (let i = 0; i < sections.length; i += 1) {
        const line = JSON.stringify({ type: 'section', index: i, html: sections[i] });
        // eslint-disable-next-line no-await-in-loop
        await writer.write(encoder.encode(`${line}\n`));
      }
      const sugLine = JSON.stringify({ type: 'suggestions', items: [{ type: 'explore', label: 'Compare espresso machines' }, { type: 'explore', label: 'Best grinders for espresso' }] });
      await writer.write(encoder.encode(`${sugLine}\n`));
      const doneLine = JSON.stringify({ type: 'done', title: 'Load test dummy page', usedProducts: [] });
      await writer.write(encoder.encode(`${doneLine}\n`));
    } finally {
      await writer.close();
    }
  })();

  request.ctx?.waitUntil?.(streamPromise);
  if (!request.ctx) streamPromise.catch(() => {});

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
 * Main handler: streams NDJSON sections via composable pipeline steps.
 */
async function handleGenerate(request, env) {
  // Full pipeline bypass: skips rate-limit, RAG, intent classification, and LLM.
  // Use to measure pure Cloudflare Worker + network overhead during load tests.
  if (request.headers.get('x-skip-pipeline') === 'true') {
    return streamDummyPipeline(request);
  }

  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const parsed = parseGenerateBody(rawBody);
  if (!parsed.ok) {
    return new Response(JSON.stringify({ error: parsed.error }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  const body = parsed.payload;
  const validSessionId = body.sessionId;
  console.log(`[Generate] query="${body.query.substring(0, 60)}" sessionId=${validSessionId || 'null'}`);

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
      // Persist session + page data after stream completes.
      // Awaited here so the worker stays alive long enough to finish the writes.
      if (validSessionId) {
        console.log(`[Generate] executeFlow done, calling saveGeneration for session=${validSessionId}`);
        const runId = await saveGeneration(ctx, env, validSessionId, {
          pageId: body.pageId,
          pageUrl: body.pageUrl,
          runId: body.runId,
          parentRunId: body.parentRunId,
        });
        console.log(`[Generate] saveGeneration result: runId=${runId || 'null'}`);
      } else {
        console.log('[Generate] skipping saveGeneration: no validSessionId');
      }
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
 * Debug: search Vectorize and return raw matches as JSON.
 * GET /api/debug/search?q=your+query[&topK=20][&type=hero-image]
 */
async function handleDebugSearch(request, env) {
  const url = new URL(request.url);
  const query = url.searchParams.get('q');
  if (!query) {
    return new Response(JSON.stringify({ error: 'Missing ?q= parameter' }), {
      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const topK = Math.min(parseInt(url.searchParams.get('topK') || '20', 10), 100);
  const typeFilter = url.searchParams.get('type') || null;

  const embeddingResponse = await env.AI.run('@cf/baai/bge-small-en-v1.5', { text: [query] });
  if (!embeddingResponse?.data?.[0]) {
    return new Response(JSON.stringify({ error: 'Embedding failed' }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const results = await env.CONTENT_INDEX.query(embeddingResponse.data[0], {
    topK, returnMetadata: 'all',
  });

  let matches = results.matches || [];
  if (typeFilter) {
    matches = matches.filter((m) => m.metadata?.type === typeFilter);
  }

  const out = matches.map((m) => ({
    score: m.score,
    id: m.id,
    ...m.metadata,
  }));

  return new Response(JSON.stringify({
    query, topK, typeFilter, count: out.length, matches: out,
  }, null, 2), {
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
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

/**
 * Receive client-side analytics events (page views, product views, etc.)
 * Accepts the sendBeacon payload from browsing-signals.js.
 * POST /api/track
 */
async function handleTrack(request, env) {
  let body;
  try {
    const text = await request.text();
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const {
    eventType = 'page_view',
    intent = '',
    metadata = {},
  } = body;
  const path = metadata.path || '';
  const pageType = classifyPageType(path);

  writeEvent(env, eventType, pageType, intent, path);
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * Return aggregated analytics stats for the dashboard.
 * GET /api/stats[?hours=24]
 */
async function handleStats(request, env) {
  const url = new URL(request.url);
  const hours = Math.min(Math.max(parseInt(url.searchParams.get('hours') || '24', 10), 1), 168);

  try {
    const stats = await queryStats(env, hours);
    if (!stats) {
      return new Response(JSON.stringify({
        error: 'Analytics not configured (CF_API_TOKEN missing)',
        summary: {},
        timeSeries: [],
        topIntents: [],
        topPaths: [],
      }), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(stats), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
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

    if (url.pathname === '/api/suggest' && request.method === 'POST') {
      return handleSuggestRequest(request, env);
    }

    if (url.pathname === '/api/persist' && request.method === 'POST') {
      return handlePersist(request, env);
    }

    if (url.pathname === '/api/debug/search' && request.method === 'GET') {
      return handleDebugSearch(request, env);
    }

    if (url.pathname === '/api/track' && request.method === 'POST') {
      return handleTrack(request, env);
    }

    if (url.pathname === '/api/stats' && request.method === 'GET') {
      return handleStats(request, env);
    }

    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // Admin routes — session browser
    if (url.pathname === '/admin' && request.method === 'GET') {
      return handleAdminUI(request, env);
    }
    if (url.pathname === '/api/admin/sessions' && request.method === 'GET') {
      return handleAdminSessions(request, env);
    }
    const sessionMatch = url.pathname.match(/^\/api\/admin\/sessions\/([^/]+)$/);
    if (sessionMatch && request.method === 'GET') {
      return handleAdminSession(request, env, sessionMatch[1]);
    }
    const pageMatch = url.pathname.match(/^\/api\/admin\/pages\/([^/]+)$/);
    if (pageMatch && request.method === 'GET') {
      return handleAdminPageGroup(request, env, pageMatch[1]);
    }
    const runMatch = url.pathname.match(/^\/api\/admin\/runs\/([^/]+)$/);
    if (runMatch && request.method === 'GET') {
      return handleAdminRun(request, env, runMatch[1]);
    }

    // Admin routes — LLM configuration
    if (url.pathname === '/api/admin/catalog' && request.method === 'GET') {
      return handleAdminCatalog(request, env);
    }
    if (url.pathname === '/api/admin/llm-config' && request.method === 'GET') {
      return handleAdminLlmConfigGet(request, env);
    }
    if (url.pathname === '/api/admin/llm-config' && request.method === 'PUT') {
      return handleAdminLlmConfigPut(request, env);
    }

    // Admin routes — experiments (multi-model A/B)
    if (url.pathname === '/api/admin/experiments') {
      if (request.method === 'POST') return handleCreateExperiment(request, env);
      if (request.method === 'GET') return handleListExperiments(request, env);
    }
    const expVarMatch = url.pathname.match(/^\/api\/admin\/experiments\/([^/]+)\/variants\/([^/]+)$/);
    if (expVarMatch && request.method === 'GET') {
      return handleGetExperimentVariant(request, env, expVarMatch[1], expVarMatch[2]);
    }
    const expMatch = url.pathname.match(/^\/api\/admin\/experiments\/([^/]+)$/);
    if (expMatch && request.method === 'GET') {
      return handleGetExperiment(request, env, expMatch[1]);
    }

    // Admin routes — LLM evaluations (suite × models with Claude judge)
    if (url.pathname === '/api/admin/eval-suites' && request.method === 'GET') {
      return handleListEvalSuites(request, env);
    }
    if (url.pathname === '/api/admin/evaluations') {
      if (request.method === 'POST') return handleCreateEvaluation(request, env);
      if (request.method === 'GET') return handleListEvaluations(request, env);
    }
    const evalQueriesMatch = url.pathname.match(/^\/api\/admin\/evaluations\/([^/]+)\/queries$/);
    if (evalQueriesMatch && request.method === 'POST') {
      return handleRunEvalQuery(request, env, evalQueriesMatch[1]);
    }
    const evalJudgeMatch = url.pathname.match(/^\/api\/admin\/evaluations\/([^/]+)\/judge$/);
    if (evalJudgeMatch && request.method === 'POST') {
      return handleJudgeEvaluation(request, env, evalJudgeMatch[1]);
    }
    const evalRejudgeMatch = url.pathname.match(
      /^\/api\/admin\/evaluations\/([^/]+)\/variants\/([^/]+)\/rejudge$/,
    );
    if (evalRejudgeMatch && request.method === 'POST') {
      return handleRejudgeVariant(request, env, evalRejudgeMatch[1], evalRejudgeMatch[2]);
    }
    const evalRegenMatch = url.pathname.match(
      /^\/api\/admin\/evaluations\/([^/]+)\/variants\/([^/]+)\/regenerate$/,
    );
    if (evalRegenMatch && request.method === 'POST') {
      return handleRegenerateVariant(request, env, evalRegenMatch[1], evalRegenMatch[2]);
    }
    const evalFinalizeMatch = url.pathname.match(/^\/api\/admin\/evaluations\/([^/]+)\/finalize$/);
    if (evalFinalizeMatch && request.method === 'POST') {
      return handleFinalizeEvaluation(request, env, evalFinalizeMatch[1]);
    }
    const evalMatch = url.pathname.match(/^\/api\/admin\/evaluations\/([^/]+)$/);
    if (evalMatch && request.method === 'GET') {
      return handleGetEvaluation(request, env, evalMatch[1]);
    }

    // Admin routes — vectorize browser
    if (url.pathname === '/api/admin/vectorize/stats' && request.method === 'GET') {
      return handleVectorizeStats(request, env);
    }
    if (url.pathname === '/api/admin/vectorize/search' && request.method === 'GET') {
      return handleVectorizeSearch(request, env);
    }
    const vecItemMatch = url.pathname.match(/^\/api\/admin\/vectorize\/items\/(.+)$/);
    if (vecItemMatch && request.method === 'GET') {
      return handleVectorizeItem(request, env, decodeURIComponent(vecItemMatch[1]));
    }

    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  },
};
