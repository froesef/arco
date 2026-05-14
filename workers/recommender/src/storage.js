/**
 * StorageManager — persists every recommender generation to D1 + KV.
 *
 * Model:
 *   session (one browser tab)
 *     └─ page (one ?q= URL visit)          — shared across initial + follow-up runs
 *         └─ run (one /api/generate call)  — initial or a single follow-up click
 *
 * D1 (SESSIONS_DB): queryable metadata. `generated_pages` is the runs table:
 *   sessions(id, ip_hash, user_agent, first_seen, last_seen, page_count)
 *   generated_pages(id=runId, session_id, page_id, page_url, run_index,
 *                   parent_run_id, follow_up_type, follow_up_label,
 *                   follow_up_options, query, ...)
 *
 * KV (SESSION_STORE): full payloads keyed by runId — "page:{runId}" (legacy
 * naming kept for back-compat) → JSON { blocks, debug, request, followUps }
 */

/**
 * Convert a `generated_pages` row (snake_case, from D1) to a run DTO
 * (camelCase, for client JSON). Centralizing this mapping keeps the
 * admin API handlers free of per-field rename lists and makes column
 * additions a one-file change.
 */
export function rowToRunDto(r) {
  if (!r) return null;
  return {
    id: r.id,
    sessionId: r.session_id,
    pageId: r.page_id,
    pageUrl: r.page_url,
    runIndex: r.run_index,
    parentRunId: r.parent_run_id,
    query: r.query,
    previousQueries: r.previous_queries,
    title: r.title,
    intentType: r.intent_type,
    journeyStage: r.journey_stage,
    flowId: r.flow_id,
    followUpType: r.follow_up_type,
    followUpLabel: r.follow_up_label,
    followUpOptions: r.follow_up_options,
    blockCount: r.block_count,
    createdAt: r.created_at,
    durationMs: r.duration_ms,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    daPath: r.da_path,
    previewUrl: r.preview_url,
    liveUrl: r.live_url,
    llmProvider: r.llm_provider,
    llmModel: r.llm_model,
  };
}

export async function hashIp(ip) {
  const data = new TextEncoder().encode(ip || 'unknown');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function upsertSession(db, sessionId, ipHash, headers, now) {
  const userAgent = (headers?.get?.('user-agent') || '').substring(0, 200);

  await db.prepare(`
    INSERT INTO sessions (id, ip_hash, user_agent, first_seen, last_seen, page_count)
    VALUES (?1, ?2, ?3, ?4, ?4, 1)
    ON CONFLICT(id) DO UPDATE SET
      last_seen = ?4,
      page_count = page_count + 1
  `).bind(sessionId, ipHash, userAgent, now).run();
}

/**
 * Determine the run_index for a new run on a given page — count existing runs
 * on the same page_id. Initial run = 0, first follow-up = 1, etc.
 */
async function nextRunIndex(db, pageId) {
  if (!pageId) return 0;
  const { results } = await db.prepare(
    'SELECT COUNT(*) as n FROM generated_pages WHERE page_id = ?1',
  ).bind(pageId).all();
  return results?.[0]?.n || 0;
}

async function insertRun(db, runId, sessionId, ctx, now, meta) {
  const intentType = ctx.intent?.type || null;
  const journeyStage = ctx.request?.inferredProfile?.journeyStage || null;
  const followUpType = ctx.request?.followUp?.type || null;
  const followUpLabel = ctx.request?.followUp?.label || null;
  const prevQueries = ctx.request?.previousQueries?.length
    ? JSON.stringify(ctx.request.previousQueries)
    : null;

  // Follow-up options presented to the user on THIS run (so they can be
  // cross-referenced with the next run's clicked follow-up).
  const followUpOptions = ctx.llm?.suggestions?.length
    ? JSON.stringify(ctx.llm.suggestions)
    : null;

  const title = ctx.llm?.sections?.[0]
    ? (() => {
      const h1 = ctx.llm.sections[0].match(/<h1[^>]*>([^<]+)<\/h1>/i);
      if (h1) return h1[1].substring(0, 200);
      const h2 = ctx.llm.sections[0].match(/<h2[^>]*>([^<]+)<\/h2>/i);
      return h2 ? h2[1].substring(0, 200) : null;
    })()
    : null;

  const durationMs = ctx.timings?.start ? Date.now() - ctx.timings.start : null;
  const inputTokens = ctx.llm?.usage?.prompt_tokens || null;
  const outputTokens = ctx.llm?.usage?.completion_tokens || null;
  const blockCount = ctx.llm?.sections?.length || 0;

  await db.prepare(`
    INSERT INTO generated_pages
      (id, session_id, page_id, page_url, run_index, parent_run_id,
       query, previous_queries, title, intent_type, journey_stage,
       flow_id, follow_up_type, follow_up_label, follow_up_options,
       block_count, created_at, duration_ms, input_tokens, output_tokens,
       da_path, preview_url, live_url, llm_provider, llm_model)
    VALUES
      (?1, ?2, ?3, ?4, ?5, ?6,
       ?7, ?8, ?9, ?10, ?11,
       ?12, ?13, ?14, ?15,
       ?16, ?17, ?18, ?19, ?20,
       ?21, ?22, ?23, ?24, ?25)
  `).bind(
    runId,
    sessionId,
    meta.pageId,
    meta.pageUrl,
    meta.runIndex,
    meta.parentRunId,
    ctx.request.query.substring(0, 500),
    prevQueries,
    title,
    intentType,
    journeyStage,
    ctx.flowId || null,
    followUpType,
    followUpLabel,
    followUpOptions,
    blockCount,
    now,
    durationMs,
    inputTokens,
    outputTokens,
    ctx.daPath || null,
    ctx.daUrls?.preview || null,
    ctx.daUrls?.live || null,
    ctx.llm?.provider || null,
    ctx.llm?.model || null,
  ).run();
}

function buildDebugSnapshot(ctx) {
  return {
    intent: ctx.intent || null,
    behaviorAnalysis: ctx.rag?.behaviorAnalysis || null,
    rag: {
      products: (ctx.rag?.products || []).map((p) => ({
        id: p.id, name: p.name, score: p.score, price: p.price,
      })),
      features: (ctx.rag?.features || []).map((f) => ({ name: f.name, benefit: f.benefit })),
      faqs: (ctx.rag?.faqs || []).map((f) => ({ question: f.question?.substring(0, 100) })),
      reviews: (ctx.rag?.reviews || []).map((r) => ({ author: r.author, productId: r.productId })),
      recipes: (ctx.rag?.recipes || []).map((r) => ({
        name: r.name, slug: r.slug, score: r.score,
      })),
      guides: (ctx.rag?.guides || []).map((g) => ({
        title: g.title, slug: g.slug, score: g.score,
      })),
      experiences: (ctx.rag?.experiences || []).map((e) => ({
        title: e.title, slug: e.slug, score: e.score,
      })),
      comparisons: (ctx.rag?.comparisons || []).map((c) => ({
        // eslint-disable-next-line no-underscore-dangle
        title: c.title, slug: c.slug, source: c._source || 'vector',
      })),
      tools: (ctx.rag?.toolContent || []).map((t) => ({
        title: t.title, slug: t.slug, score: t.score,
      })),
      persona: ctx.rag?.persona
        ? { name: ctx.rag.persona.name, slug: ctx.rag.persona.slug } : null,
      useCase: ctx.rag?.useCase
        ? { id: ctx.rag.useCase.id, name: ctx.rag.useCase.name } : null,
      heroImages: (ctx.rag?.heroImages || []).slice(0, 5).map((h) => ({
        id: h.id, score: h.score, url: h.url,
      })),
    },
    prompt: {
      systemLength: ctx.prompt?.system?.length || 0,
      userLength: ctx.prompt?.user?.length || 0,
      systemPrompt: ctx.prompt?.system || '',
      userMessage: ctx.prompt?.user || '',
    },
    timings: ctx.timings || {},
    llm: {
      provider: ctx.llm?.provider || null,
      model: ctx.llm?.model || null,
      temperature: ctx.llm?.temperature ?? null,
      maxTokens: ctx.llm?.maxTokens ?? null,
      inputTokens: ctx.llm?.usage?.prompt_tokens || null,
      outputTokens: ctx.llm?.usage?.completion_tokens || null,
      cacheReadTokens: ctx.llm?.usage?.cache_read_tokens || null,
      cacheWriteTokens: ctx.llm?.usage?.cache_write_tokens || null,
      promptCacheHit: (ctx.llm?.usage?.cache_read_tokens || 0) > 0,
      rawOutput: ctx.llm?.fullText || '',
      jsonSections: ctx.llm?.rawJsonSections || [],
      suggestions: ctx.llm?.suggestions || [],
    },
    contentStrategy: ctx.contentStrategy || null,
    qualityScore: ctx.qualityScore || null,
  };
}

/**
 * Save a completed generation to D1 + KV.
 * @param {object} ctx        Pipeline context (after executeFlow completes)
 * @param {object} env        Worker env (SESSIONS_DB, SESSION_STORE bindings)
 * @param {string} sessionId  Client-provided session UUID
 * @param {object} [meta]     { pageId, pageUrl, runId, parentRunId } from request body
 * @returns {Promise<string>} The runId
 */
// eslint-disable-next-line import/prefer-default-export
export async function saveGeneration(ctx, env, sessionId, meta = {}) {
  if (!env.SESSIONS_DB || !env.SESSION_STORE) {
    console.error('[Storage] saveGeneration skipped: missing SESSIONS_DB or SESSION_STORE bindings');
    return null;
  }

  // Use client-provided ids when available (so follow-up runs group together);
  // fall back to server-generated UUIDs for back-compat with older clients.
  const runId = meta.runId || crypto.randomUUID();
  const pageId = meta.pageId || runId; // lone run → its own page
  const pageUrl = meta.pageUrl || null;
  const parentRunId = meta.parentRunId || null;
  const now = Date.now();

  console.log(`[Storage] saveGeneration: session=${sessionId} page=${pageId} run=${runId}`);

  try {
    const ipHash = await hashIp(ctx.request?.ip);

    await upsertSession(env.SESSIONS_DB, sessionId, ipHash, ctx.request?.headers, now);

    const runIndex = await nextRunIndex(env.SESSIONS_DB, pageId);

    await insertRun(env.SESSIONS_DB, runId, sessionId, ctx, now, {
      pageId, pageUrl, runIndex, parentRunId,
    });

    const payload = {
      runId,
      pageId,
      sessionId,
      runIndex,
      pageUrl,
      parentRunId,
      blocks: (ctx.llm?.sections || []).map((html, i) => ({
        index: i,
        blockType: ctx.llm?.rawJsonSections?.[i]?.block || 'unknown',
        html,
      })),
      followUpOptions: ctx.llm?.suggestions || [],
      followUpClicked: ctx.request?.followUp || null,
      debug: buildDebugSnapshot(ctx),
      request: {
        query: ctx.request?.query,
        previousQueries: ctx.request?.previousQueries || [],
        browsingHistory: ctx.request?.browsingHistory || [],
        inferredProfile: ctx.request?.inferredProfile || null,
        behaviorProfile: ctx.request?.behaviorProfile || null,
        quizPersona: ctx.request?.quizPersona || null,
        followUp: ctx.request?.followUp || null,
      },
    };

    await env.SESSION_STORE.put(`page:${runId}`, JSON.stringify(payload), {
      expirationTtl: 60 * 60 * 24 * 90,
    });

    console.log(`[Storage] saveGeneration complete: run=${runId}`);
    return runId;
  } catch (err) {
    console.error('[Storage] saveGeneration failed:', err.message);
    return null;
  }
}
