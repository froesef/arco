/**
 * Marketing event ingest + conversion analytics.
 *
 * Public:
 *   POST /api/track                       → batch event ingest (AE + D1 dual sink)
 *
 * Admin:
 *   GET  /api/admin/insights/summary      → headline KPIs (cost, conversion)
 *   GET  /api/admin/insights/funnel       → query → card click → PDP → cart
 *   GET  /api/admin/insights/models       → per-model cost / conversion / quality
 *   GET  /api/admin/insights/segments     → per-intent and per-journey-stage breakdown
 *   GET  /api/admin/insights/timeseries   → daily cost vs. attributed value
 *
 * Attribution: an event carries `attributedRunId` when the client saw the user
 * arrive from a generated page within the attribution window. We trust but
 * verify — the run id must exist in `generated_pages` or it is discarded.
 */

import { CORS_HEADERS } from './pipeline/context.js';
import { hashIp } from './storage.js';
import { writeEvent, classifyPageType } from './analytics.js';
import { costSqlExpression } from './pricing.js';

const EVENT_TYPES = new Set([
  'page_view',
  'product_view',
  'product_card_click',
  'add_to_cart',
  'follow_up_click',
  'cta_click',
  'search',
  'engagement',
]);

// Events that also produce a `conversions` row.
const CONVERSION_TYPES = new Map([
  ['product_view', 'product_view'], // soft conversion
  ['add_to_cart', 'add_to_cart'], // hard conversion
]);

const MAX_BATCH = 50;
const MAX_VALUE_CENTS = 100_000_00; // $100k sanity ceiling
const DAY = 86_400;

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

function clean(s, max) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > max ? t.substring(0, max) : t;
}

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(Math.round(n), max));
}

/**
 * Derive a product slug from a path like /products/espresso-machines/primo.
 * @param {string} path
 * @returns {string|null}
 */
export function productSlugFromPath(path) {
  if (typeof path !== 'string') return null;
  const m = path.match(/^\/products\/[^/]+\/([^/?#]+)/);
  return m ? m[1] : null;
}

/* ========================================================================== */
/*  POST /api/track                                                            */
/* ========================================================================== */

/**
 * Normalise one raw client event into a DB row shape. Returns null if invalid.
 */
function normaliseEvent(raw, ctx) {
  if (!raw || typeof raw !== 'object') return null;

  const eventType = clean(raw.eventType, 40)?.replace(/-/g, '_').toLowerCase();
  if (!eventType || !EVENT_TYPES.has(eventType)) return null;

  const sessionId = clean(raw.sessionId, 64) || ctx.sessionId;
  if (!sessionId) return null;

  const path = clean(raw.path, 512) || '';
  const productSlug = clean(raw.productSlug, 120) || productSlugFromPath(path);

  return {
    id: crypto.randomUUID(),
    sessionId,
    pageId: clean(raw.pageId, 64),
    runId: clean(raw.runId, 64),
    attributedRunId: clean(raw.attributedRunId, 64),
    attribution: null, // resolved after validating the run id
    eventType,
    path,
    pageType: classifyPageType(path),
    productSlug,
    valueCents: clampInt(raw.valueCents, 0, MAX_VALUE_CENTS),
    dwellMs: clampInt(raw.dwellMs, 0, 24 * 60 * 60 * 1000),
    scrollPct: clampInt(raw.scrollPct, 0, 100),
    referrerPath: clean(raw.referrerPath, 512),
    createdAt: clampInt(raw.timestamp, 0, Date.now() + 60_000)
      ? Math.floor(clampInt(raw.timestamp, 0, Date.now() + 60_000) / 1000)
      : ctx.now,
  };
}

/**
 * Keep only attribution ids that actually exist in generated_pages, so a
 * spoofed or stale client id can't inflate the conversion numbers.
 */
async function validateAttribution(db, events) {
  // Default everything to 'none' first — the early return below must not leave
  // rows with a NULL attribution.
  events.forEach((e) => { e.attribution = 'none'; });

  const ids = [...new Set(events.map((e) => e.attributedRunId).filter(Boolean))];
  if (!ids.length) return;

  const placeholders = ids.map((_, i) => `?${i + 1}`).join(',');
  let known = new Set();
  try {
    const { results } = await db.prepare(
      `SELECT id FROM generated_pages WHERE id IN (${placeholders})`,
    ).bind(...ids).all();
    known = new Set((results || []).map((r) => r.id));
  } catch (err) {
    console.error('[Events] attribution lookup failed:', err.message);
    events.forEach((e) => { e.attributedRunId = null; });
    return;
  }

  events.forEach((e) => {
    if (!e.attributedRunId) return;
    if (!known.has(e.attributedRunId)) {
      e.attributedRunId = null;
      return;
    }
    // Fired on the generated page itself vs. a downstream page it referred.
    e.attribution = e.runId === e.attributedRunId ? 'direct' : 'last-touch';
  });
}

/**
 * POST /api/track
 *
 * Accepts either a single legacy event (the original browsing-signals shape)
 * or `{ events: [...] }` from the batching beacon. Always 204 — a beacon has
 * nobody to report an error to, and we must never break page unload.
 */
export async function handleTrack(request, env) {
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const rawEvents = Array.isArray(body?.events) && body.events.length
    ? body.events.slice(0, MAX_BATCH)
    : [{
      // Legacy single-event shape: metadata carried the interesting fields.
      eventType: body.eventType,
      sessionId: body.sessionId,
      path: body.metadata?.path,
      dwellMs: body.metadata?.timeSpent,
      scrollPct: body.metadata?.scrollDepth,
      intent: body.intent,
    }];

  const ctx = {
    sessionId: clean(body?.sessionId, 64),
    now: Math.floor(Date.now() / 1000),
  };

  const events = rawEvents
    .map((raw) => normaliseEvent(raw, ctx))
    .filter(Boolean);

  // Sink 1 — Analytics Engine (sampled, cheap, unchanged behaviour).
  events.forEach((e) => {
    writeEvent(env, e.eventType, e.pageType, e.productSlug || body?.intent || '', e.path, {
      durationMs: e.dwellMs || 0,
    });
  });

  // Sink 2 — D1 (exact, joinable, attributable).
  if (env.SESSIONS_DB && events.length) {
    try {
      await persistEvents(env, request, events);
    } catch (err) {
      console.error('[Events] persist failed:', err.message);
    }
  }

  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

async function persistEvents(env, request, events) {
  const db = env.SESSIONS_DB;
  await validateAttribution(db, events);

  const ipHeader = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')
    || 'unknown';
  const ipHashed = await hashIp(ipHeader.split(',')[0].trim());
  const ua = (request.headers.get('user-agent') || '').substring(0, 200);

  const statements = [];

  events.forEach((e) => {
    statements.push(db.prepare(`
      INSERT INTO page_events
        (id, session_id, page_id, run_id, attributed_run_id, attribution, event_type,
         path, page_type, product_slug, value_cents, dwell_ms, scroll_pct,
         referrer_path, created_at, ip_hash, user_agent)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
    `).bind(
      e.id,
      e.sessionId,
      e.pageId,
      e.runId,
      e.attributedRunId,
      e.attribution,
      e.eventType,
      e.path,
      e.pageType,
      e.productSlug,
      e.valueCents,
      e.dwellMs,
      e.scrollPct,
      e.referrerPath,
      e.createdAt,
      ipHashed,
      ua,
    ));

    const convType = CONVERSION_TYPES.get(e.eventType);
    if (!convType) return;

    statements.push(db.prepare(`
      INSERT INTO conversions
        (id, session_id, event_id, attributed_run_id, attribution,
         conversion_type, product_slug, value_cents, created_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
    `).bind(
      crypto.randomUUID(),
      e.sessionId,
      e.id,
      e.attributedRunId,
      e.attribution,
      convType,
      e.productSlug,
      e.valueCents,
      e.createdAt,
    ));
  });

  await db.batch(statements);
}

/* ========================================================================== */
/*  Insights queries                                                           */
/* ========================================================================== */

function sinceFrom(url, defaultDays = 30) {
  const days = Number(url.searchParams.get('days'));
  const d = Number.isFinite(days) && days > 0 ? Math.min(days, 365) : defaultDays;
  return { since: Math.floor(Date.now() / 1000) - (d * DAY), days: d };
}

/**
 * GET /api/admin/insights/summary
 */
export async function handleInsightsSummary(request, env) {
  if (!env.SESSIONS_DB) return jsonResponse({ error: 'Storage unavailable' }, { status: 503 });
  const db = env.SESSIONS_DB;
  const { since, days } = sinceFrom(new URL(request.url));
  const costExpr = costSqlExpression();

  const [gen, events, conv] = await Promise.all([
    db.prepare(`
      SELECT COUNT(*) AS runs,
             COUNT(DISTINCT COALESCE(page_id, id)) AS pages,
             COUNT(DISTINCT session_id) AS sessions,
             COALESCE(SUM(duration_ms), 0) AS total_duration_ms,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(${costExpr}), 0) AS cost_usd
      FROM generated_pages WHERE created_at >= ?1
    `).bind(since).first(),

    db.prepare(`
      SELECT event_type, COUNT(*) AS n, COUNT(DISTINCT session_id) AS sessions
      FROM page_events WHERE created_at >= ?1 GROUP BY event_type
    `).bind(since).all(),

    db.prepare(`
      SELECT conversion_type,
             COUNT(*) AS n,
             COUNT(DISTINCT session_id) AS sessions,
             COALESCE(SUM(value_cents), 0) AS value_cents,
             COALESCE(SUM(CASE WHEN attributed_run_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS attributed_n,
             COALESCE(SUM(CASE WHEN attributed_run_id IS NOT NULL THEN value_cents ELSE 0 END), 0) AS attributed_value_cents
      FROM conversions WHERE created_at >= ?1 GROUP BY conversion_type
    `).bind(since).all(),
  ]);

  const eventCounts = {};
  (events.results || []).forEach((r) => { eventCounts[r.event_type] = r.n; });

  const convByType = {};
  (conv.results || []).forEach((r) => { convByType[r.conversion_type] = r; });

  const cart = convByType.add_to_cart || {};
  const pdp = convByType.product_view || {};

  const totalSessions = Math.max(
    Number(gen?.sessions) || 0,
    ...(events.results || []).map((r) => Number(r.sessions) || 0),
  );

  const costUsdTotal = Number(gen?.cost_usd) || 0;
  const attributedValueUsd = (Number(cart.attributed_value_cents) || 0) / 100;

  const runs = Number(gen?.runs) || 0;
  // Three denominators, three different questions:
  //   run     — one /api/generate call (a follow-up chip click is its own run)
  //   page    — one ?q= visit; the initial run plus every follow-up refining it.
  //             This is "a personalised page" as a user would describe it.
  //   session — one visitor (browser tab), who may ask several unrelated things.
  // Cost per run is always the flattering one; cost per page/session is what it
  // actually costs to serve somebody.
  const pages = Number(gen?.pages) || 0;
  const genSessions = Number(gen?.sessions) || 0;

  return jsonResponse({
    days,
    generation: {
      runs,
      pages,
      sessions: genSessions,
      runsPerPage: pages ? runs / pages : 0,
      inputTokens: Number(gen?.input_tokens) || 0,
      outputTokens: Number(gen?.output_tokens) || 0,
      costUsd: costUsdTotal,
      costPerRunUsd: runs ? costUsdTotal / runs : 0,
      costPerPageUsd: pages ? costUsdTotal / pages : 0,
      costPerSessionUsd: genSessions ? costUsdTotal / genSessions : 0,
      avgDurationMs: runs ? (Number(gen?.total_duration_ms) || 0) / runs : 0,
    },
    events: eventCounts,
    conversions: {
      productViews: Number(pdp.n) || 0,
      addToCart: Number(cart.n) || 0,
      addToCartSessions: Number(cart.sessions) || 0,
      attributedAddToCart: Number(cart.attributed_n) || 0,
      cartValueUsd: (Number(cart.value_cents) || 0) / 100,
      attributedCartValueUsd: attributedValueUsd,
      aovUsd: Number(cart.n) ? (Number(cart.value_cents) || 0) / 100 / Number(cart.n) : 0,
      conversionRate: totalSessions ? (Number(cart.sessions) || 0) / totalSessions : 0,
    },
    // Surfaced in the UI so the number is never mistaken for a causal claim.
    caveat: 'Observational, not randomized. No control group is running, so these'
      + ' figures show conversions attributed to generated pages, not incremental lift.',
  });
}

/**
 * GET /api/admin/insights/funnel
 */
export async function handleInsightsFunnel(request, env) {
  if (!env.SESSIONS_DB) return jsonResponse({ error: 'Storage unavailable' }, { status: 503 });
  const db = env.SESSIONS_DB;
  const { since, days } = sinceFrom(new URL(request.url));

  const [gen, steps] = await Promise.all([
    db.prepare(
      'SELECT COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS runs FROM generated_pages WHERE created_at >= ?1',
    ).bind(since).first(),
    db.prepare(`
      SELECT event_type,
             COUNT(*) AS n,
             COUNT(DISTINCT session_id) AS sessions,
             COUNT(DISTINCT CASE WHEN attributed_run_id IS NOT NULL THEN session_id END) AS attributed_sessions
      FROM page_events
      WHERE created_at >= ?1
      GROUP BY event_type
    `).bind(since).all(),
  ]);

  const byType = {};
  (steps.results || []).forEach((r) => { byType[r.event_type] = r; });
  const get = (t, f = 'sessions') => Number(byType[t]?.[f]) || 0;

  // Steps below the entry point count ATTRIBUTED sessions only. Organic traffic
  // reaches product pages without ever seeing a generated page, and counting it
  // here produced step rates above 100% ("more product views than card clicks").
  const funnel = [
    {
      key: 'query', label: 'Generated page viewed', sessions: Number(gen?.sessions) || 0, events: Number(gen?.runs) || 0,
    },
    {
      key: 'product_card_click', label: 'Product card clicked', sessions: get('product_card_click', 'attributed_sessions'), events: get('product_card_click', 'n'),
    },
    {
      key: 'product_view', label: 'Product page viewed', sessions: get('product_view', 'attributed_sessions'), events: get('product_view', 'n'),
    },
    {
      key: 'add_to_cart', label: 'Added to cart', sessions: get('add_to_cart', 'attributed_sessions'), events: get('add_to_cart', 'n'),
    },
  ];

  const top = funnel[0].sessions || 0;
  funnel.forEach((step, i) => {
    const prev = i === 0 ? step.sessions : funnel[i - 1].sessions;
    step.stepRate = prev ? step.sessions / prev : 0;
    step.overallRate = top ? step.sessions / top : 0;
    step.dropOff = prev ? Math.max(0, prev - step.sessions) : 0;
  });

  return jsonResponse({ days, funnel });
}

/**
 * Per-run conversion rollup.
 *
 * Must be a CTE rather than correlated subqueries: inside a `GROUP BY` aggregate
 * a correlated subquery on `gp.id` resolves against one arbitrary row of each
 * group, so it silently reports the conversions of a single run instead of the
 * whole model/segment. Rolling up first keeps it one row per run, so the outer
 * LEFT JOIN cannot fan out and break the cost/token SUMs either.
 */
const RUN_CONVERSIONS_CTE = `
  conv AS (
    SELECT attributed_run_id AS run_id,
           SUM(CASE WHEN conversion_type = 'add_to_cart' THEN 1 ELSE 0 END) AS carts,
           SUM(CASE WHEN conversion_type = 'add_to_cart'
                    THEN COALESCE(value_cents, 0) ELSE 0 END) AS cart_value_cents,
           SUM(CASE WHEN conversion_type = 'product_view' THEN 1 ELSE 0 END) AS product_views
    FROM conversions
    WHERE attributed_run_id IS NOT NULL
    GROUP BY attributed_run_id
  )
`;

/**
 * GET /api/admin/insights/models
 *
 * Joins cost, conversion and the LLM-judge score per model — the "does the
 * rubric predict revenue?" view.
 */
export async function handleInsightsModels(request, env) {
  if (!env.SESSIONS_DB) return jsonResponse({ error: 'Storage unavailable' }, { status: 503 });
  const db = env.SESSIONS_DB;
  const { since, days } = sinceFrom(new URL(request.url));
  const costExpr = costSqlExpression();

  const { results } = await db.prepare(`
    WITH ${RUN_CONVERSIONS_CTE},
    fb AS (
      SELECT run_id,
             SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END)  AS up,
             SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END) AS down
      FROM run_feedback
      GROUP BY run_id
    )
    SELECT gp.llm_provider AS provider,
           gp.llm_model    AS model,
           COUNT(*)        AS runs,
           COALESCE(SUM(${costExpr}), 0) AS cost_usd,
           COALESCE(AVG(gp.duration_ms), 0) AS avg_duration_ms,
           COALESCE(SUM(gp.input_tokens), 0)  AS input_tokens,
           COALESCE(SUM(gp.output_tokens), 0) AS output_tokens,
           COALESCE(SUM(conv.carts), 0)            AS carts,
           COALESCE(SUM(conv.cart_value_cents), 0) AS cart_value_cents,
           COALESCE(SUM(conv.product_views), 0)    AS product_views,
           COALESCE(SUM(fb.up), 0)   AS up,
           COALESCE(SUM(fb.down), 0) AS down
    FROM generated_pages gp
    LEFT JOIN conv ON conv.run_id = gp.id
    LEFT JOIN fb   ON fb.run_id   = gp.id
    WHERE gp.created_at >= ?1 AND gp.llm_model IS NOT NULL
    GROUP BY gp.llm_provider, gp.llm_model
    ORDER BY runs DESC
  `).bind(since).all();

  // Judge scores live on experiment_variants, keyed by provider/model rather
  // than by run — join them in separately.
  let judgeByModel = {};
  try {
    const judged = await db.prepare(`
      SELECT provider, model, AVG(evaluator_score) AS score, COUNT(*) AS n
      FROM experiment_variants
      WHERE evaluator_score IS NOT NULL
      GROUP BY provider, model
    `).all();
    (judged.results || []).forEach((r) => {
      judgeByModel[`${r.provider}:${r.model}`] = { score: r.score, n: r.n };
    });
  } catch {
    judgeByModel = {};
  }

  const models = (results || []).map((r) => {
    const runs = Number(r.runs) || 0;
    const carts = Number(r.carts) || 0;
    const costUsdTotal = Number(r.cost_usd) || 0;
    const cartValueUsd = (Number(r.cart_value_cents) || 0) / 100;
    const judge = judgeByModel[`${r.provider}:${r.model}`] || null;
    return {
      provider: r.provider,
      model: r.model,
      runs,
      costUsd: costUsdTotal,
      costPerRunUsd: runs ? costUsdTotal / runs : 0,
      avgDurationMs: Number(r.avg_duration_ms) || 0,
      productViews: Number(r.product_views) || 0,
      carts,
      cartConversionRate: runs ? carts / runs : 0,
      cartValueUsd,
      revenuePerRunUsd: runs ? cartValueUsd / runs : 0,
      up: Number(r.up) || 0,
      down: Number(r.down) || 0,
      judgeScore: judge ? judge.score : null,
      judgeN: judge ? judge.n : 0,
    };
  });

  return jsonResponse({ days, models });
}

/**
 * GET /api/admin/insights/segments — conversion by intent and journey stage.
 */
export async function handleInsightsSegments(request, env) {
  if (!env.SESSIONS_DB) return jsonResponse({ error: 'Storage unavailable' }, { status: 503 });
  const db = env.SESSIONS_DB;
  const { since, days } = sinceFrom(new URL(request.url));

  const build = (column) => db.prepare(`
    WITH ${RUN_CONVERSIONS_CTE}
    SELECT COALESCE(gp.${column}, 'unknown') AS segment,
           COUNT(*) AS runs,
           COALESCE(SUM(conv.carts), 0)            AS carts,
           COALESCE(SUM(conv.cart_value_cents), 0) AS cart_value_cents
    FROM generated_pages gp
    LEFT JOIN conv ON conv.run_id = gp.id
    WHERE gp.created_at >= ?1
    GROUP BY COALESCE(gp.${column}, 'unknown')
    ORDER BY runs DESC
  `).bind(since).all();

  const [intent, stage] = await Promise.all([build('intent_type'), build('journey_stage')]);

  const shape = (rows) => (rows.results || []).map((r) => ({
    segment: r.segment,
    runs: Number(r.runs) || 0,
    carts: Number(r.carts) || 0,
    conversionRate: Number(r.runs) ? (Number(r.carts) || 0) / Number(r.runs) : 0,
    cartValueUsd: (Number(r.cart_value_cents) || 0) / 100,
  }));

  return jsonResponse({ days, byIntent: shape(intent), byJourneyStage: shape(stage) });
}

/**
 * GET /api/admin/insights/timeseries — daily cost vs. attributed value.
 */
export async function handleInsightsTimeseries(request, env) {
  if (!env.SESSIONS_DB) return jsonResponse({ error: 'Storage unavailable' }, { status: 503 });
  const db = env.SESSIONS_DB;
  const { since, days } = sinceFrom(new URL(request.url));
  const costExpr = costSqlExpression();

  const [gen, conv] = await Promise.all([
    db.prepare(`
      SELECT date(created_at, 'unixepoch') AS day,
             COUNT(*) AS runs,
             COALESCE(SUM(${costExpr}), 0) AS cost_usd
      FROM generated_pages WHERE created_at >= ?1 GROUP BY day ORDER BY day
    `).bind(since).all(),
    db.prepare(`
      SELECT date(created_at, 'unixepoch') AS day,
             COUNT(*) AS carts,
             COALESCE(SUM(value_cents), 0) AS value_cents
      FROM conversions
      WHERE created_at >= ?1 AND conversion_type = 'add_to_cart'
      GROUP BY day ORDER BY day
    `).bind(since).all(),
  ]);

  const byDay = new Map();
  (gen.results || []).forEach((r) => {
    byDay.set(r.day, {
      day: r.day,
      runs: Number(r.runs) || 0,
      costUsd: Number(r.cost_usd) || 0,
      carts: 0,
      valueUsd: 0,
    });
  });
  (conv.results || []).forEach((r) => {
    const row = byDay.get(r.day) || {
      day: r.day, runs: 0, costUsd: 0, carts: 0, valueUsd: 0,
    };
    row.carts = Number(r.carts) || 0;
    row.valueUsd = (Number(r.value_cents) || 0) / 100;
    byDay.set(r.day, row);
  });

  const series = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  return jsonResponse({ days, series });
}
