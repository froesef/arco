#!/usr/bin/env node
/**
 * Seed the LOCAL D1 with a plausible 7-day marketing dataset so /admin#/insights
 * has something to show during demos and local development.
 *
 * Emits SQL on stdout. Never run this against remote D1.
 *
 *   node tools/seed-demo-metrics.js > /tmp/seed.sql
 *   npx wrangler d1 execute arco-sessions --local --file=/tmp/seed.sql
 */

const DAYS = 7;
const NOW = Math.floor(Date.now() / 1000);

// Deterministic PRNG so repeated seeds produce the same dashboard.
let seed = 20260909;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (lo, hi) => Math.floor(lo + rnd() * (hi - lo + 1));

const PRODUCTS = [
  ['primo-espresso-machine', 129900],
  ['doppio-espresso-machine', 89900],
  ['arco-grinder-pro', 49900],
  ['ethiopia-yirgacheffe', 2200],
  ['colombia-huila', 1900],
  ['travel-tumbler', 3500],
];

const MODELS = [
  ['cerebras', 'gpt-oss-120b'],
  ['sambanova', 'DeepSeek-V3.2'],
  ['bedrock', 'anthropic.claude-sonnet-4-20250514-v1:0'],
];

const QUERIES = [
  ['best espresso machine for a small kitchen', 'product-recommendation', 'comparing'],
  ['how do I get less bitter espresso', 'how-to', 'exploring'],
  ['gift for someone starting with coffee', 'product-recommendation', 'deciding'],
  ['compare primo and doppio', 'comparison', 'comparing'],
  ['light roast beans for filter', 'product-recommendation', 'exploring'],
  ['what grind size for moka pot', 'how-to', 'exploring'],
];

const UAS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
];

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const lines = [];
let n = 0;
const uid = (p) => { n += 1; return `${p}-${n.toString(36)}-${Math.floor(rnd() * 1e6).toString(36)}`; };

function addEvent(e) {
  lines.push(
    'INSERT INTO page_events (id, session_id, page_id, run_id, attributed_run_id, attribution, '
    + 'event_type, path, page_type, product_slug, value_cents, dwell_ms, scroll_pct, referrer_path, '
    + `created_at, ip_hash, user_agent) VALUES (${[
      q(e.id), q(e.sessionId), q(e.pageId), q(e.runId), q(e.attributedRunId), q(e.attribution),
      q(e.eventType), q(e.path), q(e.pageType), q(e.productSlug),
      e.valueCents ?? 'NULL', e.dwellMs ?? 'NULL', e.scrollPct ?? 'NULL', q(e.referrerPath),
      e.createdAt, q(e.ipHash), q(e.userAgent),
    ].join(', ')});`,
  );
  if (e.eventType === 'product_view' || e.eventType === 'add_to_cart') {
    lines.push(
      'INSERT INTO conversions (id, session_id, event_id, attributed_run_id, attribution, '
      + `conversion_type, product_slug, value_cents, created_at) VALUES (${[
        q(uid('conv')), q(e.sessionId), q(e.id), q(e.attributedRunId), q(e.attribution),
        q(e.eventType), q(e.productSlug), e.valueCents ?? 'NULL', e.createdAt,
      ].join(', ')});`,
    );
  }
}

lines.push('DELETE FROM page_events;');
lines.push('DELETE FROM conversions;');
lines.push("DELETE FROM generated_pages WHERE id LIKE 'run-%';");
lines.push("DELETE FROM sessions WHERE id LIKE 'seed-%';");

for (let day = DAYS - 1; day >= 0; day -= 1) {
  const dayStart = NOW - day * 86400;
  // Weekday-ish volume wobble so the timeseries chart is not a flat line.
  const volume = [18, 24, 21, 26, 23, 12, 14][day % 7];

  for (let i = 0; i < volume; i += 1) {
    const usesRecommender = rnd() < 0.5;
    const sessionId = uid('seed');
    const ua = pick(UAS);
    const ipHash = uid('ip');
    const t0 = dayStart + between(0, 80000);

    lines.push(
      `INSERT INTO sessions (id, ip_hash, user_agent, first_seen, last_seen, page_count) VALUES (${[
        q(sessionId), q(ipHash), q(ua), t0, t0 + between(60, 900), between(1, 6),
      ].join(', ')});`,
    );

    const base = {
      sessionId, ipHash, userAgent: ua, pageId: null, runId: null,
      attributedRunId: null, attribution: 'none',
    };

    if (usesRecommender) {
      const [query, intent, stage] = pick(QUERIES);
      const [provider, model] = pick(MODELS);
      const runId = uid('run');
      const pageId = uid('page');
      const inTok = between(9000, 16000);
      const outTok = between(1200, 2600);

      lines.push(
        'INSERT INTO generated_pages (id, session_id, page_id, page_url, run_index, query, title, '
        + 'intent_type, journey_stage, flow_id, block_count, created_at, duration_ms, input_tokens, '
        + `output_tokens, llm_provider, llm_model) VALUES (${[
          q(runId), q(sessionId), q(pageId), q(`/?q=${encodeURIComponent(query)}`), 0, q(query),
          q(query.replace(/^./, (c) => c.toUpperCase())), q(intent), q(stage), q('default'),
          between(4, 9), t0, between(2600, 9000), inTok, outTok, q(provider), q(model),
        ].join(', ')});`,
      );

      const ctx = {
        ...base, pageId, runId, attributedRunId: runId, attribution: 'direct',
      };
      addEvent({
        ...ctx, id: uid('ev'), eventType: 'search', path: '/', pageType: 'recommender', createdAt: t0,
      });
      addEvent({
        ...ctx,
        id: uid('ev'),
        eventType: 'engagement',
        path: '/',
        pageType: 'recommender',
        dwellMs: between(15000, 120000),
        scrollPct: between(40, 100),
        createdAt: t0 + between(20, 180),
      });

      // Follow-up chips get clicked about a third of the time. Each click is a
      // NEW run on the SAME page_id — this is what makes runs > pages, and it is
      // the whole reason cost-per-run and cost-per-page differ.
      let followUps = 0;
      if (rnd() < 0.35) followUps = between(1, 2);
      for (let f = 1; f <= followUps; f += 1) {
        const tFollow = t0 + f * between(30, 120);
        addEvent({
          ...ctx, id: uid('ev'), eventType: 'follow_up_click', path: '/', pageType: 'recommender', createdAt: tFollow,
        });
        const fRunId = uid('run');
        const fIn = between(9000, 16000);
        const fOut = between(1200, 2600);
        lines.push(
          'INSERT INTO generated_pages (id, session_id, page_id, page_url, run_index, parent_run_id, '
          + 'query, title, intent_type, journey_stage, flow_id, block_count, created_at, duration_ms, '
          + `input_tokens, output_tokens, llm_provider, llm_model) VALUES (${[
            q(fRunId), q(sessionId), q(pageId), q(`/?q=${encodeURIComponent(query)}`), f, q(runId),
            q(query), q('Follow-up'), q(intent), q(stage), q('default'),
            between(3, 7), tFollow, between(2600, 9000), fIn, fOut, q(provider), q(model),
          ].join(', ')});`,
        );
      }

      // Generated pages surface product cards — strong path into the PDP.
      if (rnd() < 0.72) {
        const [slug, price] = pick(PRODUCTS);
        const tClick = t0 + between(40, 300);
        addEvent({
          ...ctx, id: uid('ev'), eventType: 'product_card_click', path: '/', pageType: 'recommender', productSlug: slug, createdAt: tClick,
        });
        addEvent({
          ...ctx,
          id: uid('ev'),
          eventType: 'product_view',
          path: `/products/${slug}`,
          pageType: 'product',
          productSlug: slug,
          valueCents: price,
          referrerPath: '/',
          attribution: 'last-touch',
          createdAt: tClick + between(2, 20),
        });
        // Assisted sessions convert harder — this is the story the demo tells.
        if (rnd() < 0.24) {
          addEvent({
            ...ctx,
            id: uid('ev'),
            eventType: 'add_to_cart',
            path: `/products/${slug}`,
            pageType: 'product',
            productSlug: slug,
            valueCents: price,
            attribution: 'last-touch',
            createdAt: tClick + between(25, 400),
          });
        }
      }
    } else {
      addEvent({
        ...base, id: uid('ev'), eventType: 'page_view', path: '/', pageType: 'home', createdAt: t0,
      });
      addEvent({
        ...base,
        id: uid('ev'),
        eventType: 'engagement',
        path: '/',
        pageType: 'home',
        dwellMs: between(4000, 45000),
        scrollPct: between(15, 80),
        createdAt: t0 + between(10, 90),
      });
      if (rnd() < 0.45) {
        const [slug, price] = pick(PRODUCTS);
        const tView = t0 + between(20, 200);
        addEvent({
          ...base,
          id: uid('ev'),
          eventType: 'product_view',
          path: `/products/${slug}`,
          pageType: 'product',
          productSlug: slug,
          valueCents: price,
          referrerPath: '/',
          createdAt: tView,
        });
        if (rnd() < 0.09) {
          addEvent({
            ...base,
            id: uid('ev'),
            eventType: 'add_to_cart',
            path: `/products/${slug}`,
            pageType: 'product',
            productSlug: slug,
            valueCents: price,
            createdAt: tView + between(30, 500),
          });
        }
      }
    }
  }
}

process.stdout.write(`${lines.join('\n')}\n`);
