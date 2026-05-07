/**
 * Eval run orchestrator — runs a query suite across N models and judges each
 * generation with Claude. Streams NDJSON progress events to the client.
 *
 * Per query (sequential across queries to keep RAG load bounded):
 *   1. Build a fresh pipeline ctx
 *   2. Run gates + non-LLM upstream steps once
 *   3. Fan out llm-generate across all models in parallel (runLlmVariant)
 *   4. Persist each variant to D1 + KV (mirrors experiments.js)
 *   5. Dispatch judge calls with limited concurrency
 *   6. Update each variant's evaluator_score / evaluator_notes
 *
 * Across queries: sequential (one upstream pipeline at a time).
 */

import { createContext, CORS_HEADERS } from '../pipeline/context.js';
import { executeFlow } from '../pipeline/executor.js';
import { resolveFlow } from '../pipeline/flows.js';
import { STEPS } from '../pipeline/steps/index.js';
import { runLlmVariant, createVariantState, extractTitle } from '../pipeline/steps/llm-generate.js';
import { setHeroResult } from '../images.js';
import { selectHeroImage } from '../hero-images.js';
import { extractProductIds } from '../context.js';
import { findCatalogEntry, catalogAvailability } from '../providers/index.js';
import { resolveLlmConfig } from '../llm-config.js';
import { getSuite } from './suites.js';
import {
  judgeVariant, isValidJudgeModel, getJudgeRates, JUDGE_MODELS,
} from './judge.js';
import { runAssertions } from './assertions.js';

// Soft thresholds. We flag a cell as a "blocker" when faithfulness or structure
// score below 3 OR any deterministic assertion fails — but we no longer cap the
// composite score. The badge is purely informational; the cell shows the raw
// judge score so trends and ranking stay visible.
const FAITHFULNESS_GATE = 3;
const STRUCTURE_GATE = 3;

function detectBlocker(dims, assertions) {
  const reasons = [];
  if (assertions && !assertions.passed) reasons.push('assertions-failed');
  if ((dims?.faithfulness?.score || 0) > 0 && dims.faithfulness.score < FAITHFULNESS_GATE) {
    reasons.push(`faithfulness<${FAITHFULNESS_GATE}`);
  }
  if ((dims?.structure?.score || 0) > 0 && dims.structure.score < STRUCTURE_GATE) {
    reasons.push(`structure<${STRUCTURE_GATE}`);
  }
  return { blocker: reasons.length > 0, reasons };
}

const VARIANT_KV_TTL = 60 * 60 * 24 * 90; // 90 days
const JUDGE_CONCURRENCY = 4;
const DEFAULT_QUERY_CONCURRENCY = 3;
const MAX_QUERY_CONCURRENCY = 6;
const DEFAULT_REJUDGE_CONCURRENCY = 2;
const MAX_REJUDGE_CONCURRENCY = 4;
const KV_KEY = (expId, varId) => `experiment:${expId}:variant:${varId}`;
const RAG_KV_KEY = (expId) => `experiment:${expId}:rag-context`;

// ── Validation ────────────────────────────────────────────────────────────────

export function validateRunBody(body, env) {
  if (!body || typeof body !== 'object') return { error: 'Invalid body' };
  const suite = getSuite(body.suiteId);
  if (!suite) return { error: `Unknown suite: ${body.suiteId}` };
  if (!suite.queries.length) return { error: 'Suite has no queries' };

  const rawModels = Array.isArray(body.models) ? body.models : [];
  if (!rawModels.length) return { error: 'At least one model is required' };
  if (rawModels.length > 8) return { error: 'At most 8 models per evaluation run' };

  const models = [];
  for (let i = 0; i < rawModels.length; i += 1) {
    const m = rawModels[i];
    if (!m || typeof m !== 'object') return { error: `model[${i}] must be an object` };
    const entry = findCatalogEntry(m.provider, m.model);
    if (!entry) return { error: `model[${i}] unknown provider/model: ${m.provider}/${m.model}` };
    const { available, missing } = catalogAvailability(entry, env);
    if (!available) {
      return { error: `model[${i}] (${entry.label}) not available — missing: ${missing.join(', ')}` };
    }
    const temperature = typeof m.temperature === 'number' && !Number.isNaN(m.temperature)
      ? Math.max(0, Math.min(2, m.temperature))
      : null;
    const maxTokens = typeof m.maxTokens === 'number' && !Number.isNaN(m.maxTokens)
      ? Math.max(256, Math.min(16384, Math.round(m.maxTokens)))
      : null;
    models.push({
      provider: entry.provider,
      model: entry.model,
      label: entry.label,
      temperature,
      maxTokens,
    });
  }

  const judgeModel = body.judgeModel || 'claude-sonnet-4-6';
  if (!isValidJudgeModel(judgeModel)) {
    return { error: `Unknown judge model: ${judgeModel}` };
  }

  let queryConcurrency = typeof body.queryConcurrency === 'number'
    ? Math.round(body.queryConcurrency)
    : DEFAULT_QUERY_CONCURRENCY;
  queryConcurrency = Math.max(1, Math.min(MAX_QUERY_CONCURRENCY, queryConcurrency));

  return {
    payload: {
      suite,
      models,
      judgeModel,
      queryConcurrency,
    },
  };
}

// ── Cost estimate (judge only — generation cost varies wildly per provider) ──

function estimateJudgeCost({ queryCount, modelCount, judgeModel }) {
  const rates = getJudgeRates(judgeModel);
  // Rough heuristics — judge sees query, RAG summary, and ~3k tokens of HTML.
  const inputTokensPerCall = 5000;
  const outputTokensPerCall = 500;
  const calls = queryCount * modelCount;
  const inputCost = (calls * inputTokensPerCall * rates.inputPerMillion) / 1_000_000;
  const outputCost = (calls * outputTokensPerCall * rates.outputPerMillion) / 1_000_000;
  return Math.round((inputCost + outputCost) * 100) / 100;
}

// ── D1 helpers (mirrors experiments.js shape so the matrix can join cleanly) ─

async function insertEvalRunRow(db, row) {
  await db.prepare(`
    INSERT INTO eval_runs
      (id, suite_id, suite_name, suite_version, models_json, judge_provider,
       judge_model, status, created_at, query_count, model_count, variant_count,
       estimated_cost_usd)
    VALUES (?1, ?2, ?3, ?4, ?5, 'anthropic', ?6, 'running', ?7, ?8, ?9, ?10, ?11)
  `).bind(
    row.id,
    row.suiteId,
    row.suiteName,
    row.suiteVersion,
    JSON.stringify(row.models),
    row.judgeModel,
    row.createdAt,
    row.queryCount,
    row.modelCount,
    row.variantCount,
    row.estimatedCostUsd,
  ).run();
}

async function finalizeEvalRunRow(db, row) {
  await db.prepare(`
    UPDATE eval_runs
    SET status = ?1, completed_at = ?2,
        total_input_tokens = ?3, total_output_tokens = ?4,
        judge_input_tokens = ?5, judge_output_tokens = ?6,
        summary_json = ?7, error = ?8
    WHERE id = ?9
  `).bind(
    row.status,
    Date.now(),
    row.totalInputTokens || 0,
    row.totalOutputTokens || 0,
    row.judgeInputTokens || 0,
    row.judgeOutputTokens || 0,
    row.summaryJson ? JSON.stringify(row.summaryJson) : null,
    row.error || null,
    row.id,
  ).run();
}

async function insertExperimentRow(db, exp) {
  await db.prepare(`
    INSERT INTO experiments
      (id, session_id, query, page_url, variant_count, status, created_at,
       shared_intent_type, shared_journey_stage, eval_run_id, eval_query_id)
    VALUES (?1, NULL, ?2, NULL, ?3, 'running', ?4, ?5, ?6, ?7, ?8)
  `).bind(
    exp.id,
    exp.query,
    exp.variantCount,
    exp.createdAt,
    exp.intentType,
    exp.journeyStage,
    exp.evalRunId,
    exp.evalQueryId,
  ).run();
}

async function insertVariantRow(db, v) {
  await db.prepare(`
    INSERT INTO experiment_variants
      (id, experiment_id, variant_index, provider, model,
       temperature, max_tokens, status)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running')
  `).bind(
    v.id,
    v.experimentId,
    v.variantIndex,
    v.provider,
    v.model,
    v.temperature,
    v.maxTokens,
  ).run();
}

async function finalizeVariantRow(db, v) {
  await db.prepare(`
    UPDATE experiment_variants
    SET status = ?1, duration_ms = ?2, input_tokens = ?3, output_tokens = ?4,
        title = ?5, block_count = ?6, error = ?7, time_to_first_token_ms = ?8
    WHERE id = ?9
  `).bind(
    v.status,
    v.durationMs,
    v.inputTokens,
    v.outputTokens,
    v.title,
    v.blockCount,
    v.error,
    v.ttftMs ?? null,
    v.id,
  ).run();
}

async function finalizeExperimentRow(db, expId, status, sharedDurationMs) {
  await db.prepare(`
    UPDATE experiments
    SET status = ?1, completed_at = ?2, shared_duration_ms = ?3
    WHERE id = ?4
  `).bind(status, Date.now(), sharedDurationMs, expId).run();
}

async function writeVariantJudgeResult(db, variantId, judgement, assertions, blockerInfo) {
  await db.prepare(`
    UPDATE experiment_variants
    SET evaluator_score = ?1, evaluator_notes = ?2
    WHERE id = ?3
  `).bind(
    judgement.score ?? null,
    JSON.stringify({
      judge_model: judgement.judgeModel,
      judge_input_tokens: judgement.inputTokens,
      judge_output_tokens: judgement.outputTokens,
      judge_duration_ms: judgement.durationMs,
      structure: judgement.dims.structure,
      intent: judgement.dims.intent,
      faithfulness: judgement.dims.faithfulness,
      helpfulness: judgement.dims.helpfulness,
      brandVoice: judgement.dims.brandVoice,
      specificity: judgement.dims.specificity,
      visualAssetUsage: judgement.dims.visualAssetUsage,
      blocker: blockerInfo.blocker,
      blocker_reasons: blockerInfo.reasons,
      assertions: assertions || null,
    }),
    variantId,
  ).run();
}

async function writeVariantAssertionsOnly(db, variantId, assertions, blockerInfo) {
  // For variants where the judge couldn't run (gen error etc.), still persist
  // assertion results so the matrix can show structural problems.
  await db.prepare(`
    UPDATE experiment_variants
    SET evaluator_notes = ?1
    WHERE id = ?2
  `).bind(
    JSON.stringify({
      assertions,
      blocker: blockerInfo.blocker,
      blocker_reasons: blockerInfo.reasons,
    }),
    variantId,
  ).run();
}

async function writeVariantJudgeError(db, variantId, message) {
  await db.prepare(`
    UPDATE experiment_variants
    SET evaluator_notes = ?1
    WHERE id = ?2
  `).bind(JSON.stringify({ judge_error: message }), variantId).run();
}

// ── KV payload (same shape as experiments.js so the variant viewer reuses) ──

function buildVariantPayload(ctx, v) {
  const { state } = v;
  return {
    variantId: v.id,
    experimentId: v.experimentId,
    variantIndex: v.variantIndex,
    provider: v.provider,
    model: v.model,
    temperature: v.temperature,
    maxTokens: v.maxTokens,
    blocks: (state.sections || []).map((html, i) => ({
      index: i,
      blockType: state.rawJsonSections?.[i]?.block || 'unknown',
      html,
    })),
    followUpOptions: state.suggestions || [],
    debug: {
      intent: ctx.intent || null,
      behaviorAnalysis: ctx.rag?.behaviorAnalysis || null,
      prompt: {
        systemLength: ctx.prompt?.system?.length || 0,
        userLength: ctx.prompt?.user?.length || 0,
        systemPrompt: ctx.prompt?.system || '',
        userMessage: ctx.prompt?.user || '',
      },
      ttftMs: v.ttftMs ?? null,
      timings: v.timings || {},
      llm: {
        provider: v.provider,
        model: v.model,
        temperature: v.temperature,
        maxTokens: v.maxTokens,
        inputTokens: state.usage?.prompt_tokens || null,
        outputTokens: state.usage?.completion_tokens || null,
        rawOutput: state.fullText || '',
        jsonSections: state.rawJsonSections || [],
        suggestions: state.suggestions || [],
      },
      error: v.error || null,
    },
    request: {
      query: ctx.request?.query,
      previousQueries: ctx.request?.previousQueries || [],
      browsingHistory: ctx.request?.browsingHistory || [],
      inferredProfile: ctx.request?.inferredProfile || null,
    },
  };
}

// ── Concurrency-limited pool ──────────────────────────────────────────────────

async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        results[i] = await fn(items[i], i);
      } catch (err) {
        results[i] = { error: err };
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ── Per-query execution ───────────────────────────────────────────────────────

async function runOneQuery({
  env, request, query, queryDef, models, evalRunId, judgeModel, writeLine, skipJudge,
}) {
  // Fresh ctx for this query — upstream pipeline is run independently per query.
  const ctx = createContext({ query }, request);
  const flow = resolveFlow('default');
  ctx.flowId = flow.id;
  ctx.flowName = flow.name || flow.id;
  // We need a writer for runLlmVariant's tagged events; attach the shared NDJSON writer.
  ctx.writer = request.evalWriter;
  ctx.encoder = request.evalEncoder;
  ctx.timings.steps = [];

  // Gates first.
  const gateSteps = flow.steps.filter((s) => s.gate);
  for (let gi = 0; gi < gateSteps.length; gi += 1) {
    if (ctx.earlyResponse) break;
    const s = gateSteps[gi];
    const gateStart = Date.now();
    // eslint-disable-next-line no-await-in-loop
    await STEPS[s.step](ctx, s.config || {}, env);
    ctx.timings.steps.push({ step: s.step, ms: Date.now() - gateStart, gate: true });
  }
  if (ctx.earlyResponse) {
    await writeLine({
      type: 'query-error',
      queryId: queryDef.id,
      message: 'rate-limited or gated before pipeline',
    });
    return null;
  }

  // Non-llm upstream.
  const upstreamSteps = flow.steps.filter(
    (s) => !s.gate && !(s.step === 'llm-generate'),
  );
  const upstreamStart = Date.now();
  await executeFlow(upstreamSteps, ctx, env);
  const sharedDurationMs = Date.now() - upstreamStart;

  // Pin hero image once so all variants share it.
  const heroImage = selectHeroImage({
    query: ctx.request?.query,
    useCases: ctx.rag?.useCase?.useCases,
    intentType: ctx.intent?.type,
    productIds: extractProductIds(ctx.request?.query || ''),
  }, ctx.rag?.heroImages || []);
  setHeroResult(heroImage);

  const intentType = ctx.intent?.type || null;
  const journeyStage = ctx.request?.inferredProfile?.journeyStage || null;
  const experimentId = crypto.randomUUID();

  // Persist RAG context once per experiment so re-judge / re-generate can rebuild
  // the judge prompt without re-running the upstream pipeline (which costs Vectorize +
  // model calls). Shared by all variants of this query.
  if (env.SESSION_STORE) {
    try {
      await env.SESSION_STORE.put(
        RAG_KV_KEY(experimentId),
        JSON.stringify({
          rag: ctx.rag || {},
          intent: ctx.intent || null,
          journeyStage,
          query,
          queryId: queryDef.id,
        }),
        { expirationTtl: VARIANT_KV_TTL },
      );
    } catch (kvErr) {
      console.error('[Eval] RAG context KV write failed:', kvErr.message);
    }
  }

  await writeLine({
    type: 'query-start',
    queryId: queryDef.id,
    experimentId,
    query,
    intentType,
    journeyStage,
    sharedDurationMs,
  });

  // Build variants for this query.
  const variants = models.map((m, i) => {
    const resolved = resolveLlmConfig(
      {
        provider: m.provider, model: m.model, temperature: m.temperature, maxTokens: m.maxTokens,
      },
      flow.steps.find((s) => s.step === 'llm-generate')?.config || {},
    );
    return {
      id: crypto.randomUUID(),
      experimentId,
      variantIndex: i,
      provider: resolved.provider,
      model: resolved.model,
      label: m.label,
      temperature: resolved.temperature,
      maxTokens: resolved.maxTokens,
      state: createVariantState(),
      timings: {},
      status: 'running',
      startedAt: null,
      finishedAt: null,
      error: null,
      ttftMs: null,
      title: null,
    };
  });

  // Persist experiment + variant rows up front so the matrix can render them
  // even before generation completes.
  if (env.SESSIONS_DB) {
    try {
      await insertExperimentRow(env.SESSIONS_DB, {
        id: experimentId,
        query,
        variantCount: variants.length,
        createdAt: Date.now(),
        intentType,
        journeyStage,
        evalRunId,
        evalQueryId: queryDef.id,
      });
      await Promise.all(variants.map((v) => insertVariantRow(env.SESSIONS_DB, v)));
    } catch (dbErr) {
      console.error('[Eval] pre-fanout D1 insert failed:', dbErr.message);
    }
  }

  // Fan out variants in parallel.
  await Promise.all(variants.map(async (v) => {
    v.startedAt = Date.now();
    await writeLine({
      type: 'variant-start',
      queryId: queryDef.id,
      experimentId,
      variantId: v.id,
      provider: v.provider,
      model: v.model,
      label: v.label,
      temperature: v.temperature,
      maxTokens: v.maxTokens,
    });
    try {
      const { title } = await runLlmVariant(ctx, env, {
        variantId: v.id,
        provider: v.provider,
        model: v.model,
        temperature: v.temperature,
        maxTokens: v.maxTokens,
        out: v.state,
        timings: v.timings,
        emitDebug: false,
        emitDone: false,
      });
      v.finishedAt = Date.now();
      v.status = 'complete';
      v.title = title || extractTitle(v.state.sections[0] || '');
      v.ttftMs = (v.timings.llmFirstToken && v.timings.llmStart)
        ? v.timings.llmFirstToken - v.timings.llmStart
        : null;
      const inputTokens = v.state.usage?.prompt_tokens || 0;
      const outputTokens = v.state.usage?.completion_tokens || 0;
      const durationMs = v.finishedAt - v.startedAt;
      const tokensPerSec = (outputTokens && durationMs)
        ? Math.round(outputTokens / (durationMs / 1000))
        : null;
      await writeLine({
        type: 'variant-done',
        queryId: queryDef.id,
        experimentId,
        variantId: v.id,
        durationMs,
        ttftMs: v.ttftMs,
        inputTokens,
        outputTokens,
        tokensPerSec,
        title: v.title,
        blockCount: v.state.sections.length,
      });
    } catch (err) {
      v.finishedAt = Date.now();
      v.status = 'error';
      v.error = err.message || 'variant failed';
      await writeLine({
        type: 'variant-error',
        queryId: queryDef.id,
        experimentId,
        variantId: v.id,
        message: v.error,
      });
    }
  }));

  // Persist KV payloads + finalize variant rows.
  if (env.SESSION_STORE && env.SESSIONS_DB) {
    await Promise.all(variants.map(async (v) => {
      try {
        const payload = buildVariantPayload(ctx, v);
        await env.SESSION_STORE.put(
          KV_KEY(experimentId, v.id),
          JSON.stringify(payload),
          { expirationTtl: VARIANT_KV_TTL },
        );
      } catch (kvErr) {
        console.error(`[Eval] variant KV write failed (${v.id}):`, kvErr.message);
      }
      try {
        await finalizeVariantRow(env.SESSIONS_DB, {
          id: v.id,
          status: v.status,
          durationMs: v.finishedAt && v.startedAt ? v.finishedAt - v.startedAt : null,
          ttftMs: v.ttftMs ?? null,
          inputTokens: v.state.usage?.prompt_tokens || null,
          outputTokens: v.state.usage?.completion_tokens || null,
          title: v.title,
          blockCount: v.state.sections.length,
          error: v.error,
        });
      } catch (dbErr) {
        console.error(`[Eval] variant D1 finalize failed (${v.id}):`, dbErr.message);
      }
    }));
  }

  // Deterministic assertions — run on every completed variant. Cheap, perfectly
  // reliable, no token cost. Catches structural defects the judge often misses
  // (broken {{story:slug}} tokens, unbalanced HTML, etc.).
  // Always run, even when skipJudge=true, so the matrix can show structural
  // problems immediately after generation.
  const assertionsByVariant = new Map();
  await Promise.all(variants.map(async (v) => {
    if (v.status !== 'complete' || !v.state.sections.length) return;
    const blocks = v.state.sections.map((html, i) => ({
      index: i,
      blockType: v.state.rawJsonSections?.[i]?.block || 'unknown',
      html,
    }));
    const assertions = runAssertions(blocks, queryDef);
    assertionsByVariant.set(v.id, assertions);
    await writeLine({
      type: 'assertions-done',
      queryId: queryDef.id,
      experimentId,
      variantId: v.id,
      passed: assertions.passed,
      counts: assertions.counts,
      violations: assertions.violations,
    });
  }));

  // When skipJudge is true (two-phase mode), persist assertion findings so the
  // matrix can render structural blockers immediately, then return without
  // calling the judge. The bulk judge phase will be invoked separately.
  if (skipJudge) {
    if (env.SESSIONS_DB) {
      await Promise.all(variants.map(async (v) => {
        const assertions = assertionsByVariant.get(v.id);
        if (!assertions) return;
        const blockerInfo = {
          blocker: !assertions.passed,
          reasons: assertions.passed ? [] : ['assertions-failed'],
        };
        try {
          await writeVariantAssertionsOnly(env.SESSIONS_DB, v.id, assertions, blockerInfo);
        } catch { /* ignore */ }
      }));
      try {
        const anyComplete = variants.some((v) => v.status === 'complete');
        const expStatus = anyComplete ? 'complete' : 'error';
        await finalizeExperimentRow(env.SESSIONS_DB, experimentId, expStatus, sharedDurationMs);
      } catch (dbErr) {
        console.error('[Eval] experiment finalize failed:', dbErr.message);
      }
    }
    await writeLine({
      type: 'query-done',
      queryId: queryDef.id,
      experimentId,
      variantCount: variants.length,
      completedCount: variants.filter((v) => v.status === 'complete').length,
      judgedCount: 0,
      skippedJudge: true,
    });
    const generationInputTokensSkip = variants.reduce(
      (n, v) => n + (v.state.usage?.prompt_tokens || 0),
      0,
    );
    const generationOutputTokensSkip = variants.reduce(
      (n, v) => n + (v.state.usage?.completion_tokens || 0),
      0,
    );
    return {
      queryId: queryDef.id,
      experimentId,
      variants,
      judgements: [],
      generationInputTokens: generationInputTokensSkip,
      generationOutputTokens: generationOutputTokensSkip,
      judgeInputTokens: 0,
      judgeOutputTokens: 0,
    };
  }

  // Judge — concurrency-limited, only completed variants.
  const judgeable = variants.filter((v) => v.status === 'complete' && v.state.sections.length > 0);
  const judgements = await runWithConcurrency(judgeable, JUDGE_CONCURRENCY, async (v) => {
    const assertions = assertionsByVariant.get(v.id) || null;
    try {
      const result = await judgeVariant(env, {
        judgeModel,
        query,
        expectedIntent: queryDef.expectedIntent || null,
        expectedBehavior: queryDef.expectedBehavior || null,
        classifiedIntent: intentType,
        journeyStage,
        rag: ctx.rag || {},
        blocks: v.state.sections.map((html, i) => ({
          index: i,
          blockType: v.state.rawJsonSections?.[i]?.block || 'unknown',
          html,
        })),
      });
      const blockerInfo = detectBlocker(result.dims, assertions);
      if (env.SESSIONS_DB) {
        await writeVariantJudgeResult(env.SESSIONS_DB, v.id, result, assertions, blockerInfo);
      }
      await writeLine({
        type: 'judge-done',
        queryId: queryDef.id,
        experimentId,
        variantId: v.id,
        score: result.score,
        blocker: blockerInfo.blocker,
        blockerReasons: blockerInfo.reasons,
        summary: result.summary,
        dims: result.dims,
        judgeModel: result.judgeModel,
        judgeInputTokens: result.inputTokens,
        judgeOutputTokens: result.outputTokens,
        judgeDurationMs: result.durationMs,
      });
      return { ...result, blocker: blockerInfo.blocker };
    } catch (err) {
      const message = err.message || 'judge failed';
      console.error(`[Eval] judge failed (${v.id}):`, message);
      if (env.SESSIONS_DB) {
        try { await writeVariantJudgeError(env.SESSIONS_DB, v.id, message); } catch { /* ignore */ }
      }
      // Still persist assertion findings so the cell can show structural blockers
      // even when the judge couldn't grade.
      if (assertions && env.SESSIONS_DB) {
        const blockerInfo = {
          blocker: !assertions.passed,
          reasons: assertions.passed ? [] : ['assertions-failed'],
        };
        try {
          await writeVariantAssertionsOnly(env.SESSIONS_DB, v.id, assertions, blockerInfo);
        } catch { /* ignore */ }
      }
      await writeLine({
        type: 'judge-error',
        queryId: queryDef.id,
        experimentId,
        variantId: v.id,
        message,
      });
      return { error: message };
    }
  });

  // Finalize experiment row with shared duration.
  if (env.SESSIONS_DB) {
    try {
      const anyComplete = variants.some((v) => v.status === 'complete');
      const expStatus = anyComplete ? 'complete' : 'error';
      await finalizeExperimentRow(env.SESSIONS_DB, experimentId, expStatus, sharedDurationMs);
    } catch (dbErr) {
      console.error('[Eval] experiment finalize failed:', dbErr.message);
    }
  }

  await writeLine({
    type: 'query-done',
    queryId: queryDef.id,
    experimentId,
    variantCount: variants.length,
    completedCount: variants.filter((v) => v.status === 'complete').length,
    judgedCount: judgements.filter((j) => j && !j.error).length,
  });

  // Aggregate totals for the run summary.
  const generationInputTokens = variants.reduce(
    (n, v) => n + (v.state.usage?.prompt_tokens || 0),
    0,
  );
  const generationOutputTokens = variants.reduce(
    (n, v) => n + (v.state.usage?.completion_tokens || 0),
    0,
  );
  const judgeInputTokens = judgements.reduce(
    (n, j) => n + (j && !j.error ? (j.inputTokens || 0) : 0),
    0,
  );
  const judgeOutputTokens = judgements.reduce(
    (n, j) => n + (j && !j.error ? (j.outputTokens || 0) : 0),
    0,
  );

  return {
    queryId: queryDef.id,
    experimentId,
    variants,
    judgements,
    generationInputTokens,
    generationOutputTokens,
    judgeInputTokens,
    judgeOutputTokens,
  };
}

// ── Split orchestration: client drives one Worker invocation per query ───────
// Cloudflare Workers cap each invocation at 1000 subrequests (Vectorize, fetch,
// D1, KV, AI). One full suite × N models × judge calls easily exceeds that, so
// we split: create the run, run each query in its own invocation, finalize.

export async function createEvalRun(env, payload) {
  const {
    suite, models, judgeModel, queryConcurrency,
  } = payload;
  const evalRunId = crypto.randomUUID();
  const variantCount = suite.queries.length * models.length;
  const estimatedCostUsd = estimateJudgeCost({
    queryCount: suite.queries.length,
    modelCount: models.length,
    judgeModel,
  });

  if (env.SESSIONS_DB) {
    await insertEvalRunRow(env.SESSIONS_DB, {
      id: evalRunId,
      suiteId: suite.id,
      suiteName: suite.name,
      suiteVersion: suite.version || 1,
      models,
      judgeModel,
      createdAt: Date.now(),
      queryCount: suite.queries.length,
      modelCount: models.length,
      variantCount,
      estimatedCostUsd,
    });
  }

  return {
    evalRunId,
    suiteId: suite.id,
    suiteName: suite.name,
    queries: suite.queries.map((q) => ({
      id: q.id,
      size: q.size || null,
      expectedIntent: q.expectedIntent || null,
      query: q.query,
    })),
    models,
    judgeModel,
    queryConcurrency,
    variantCount,
    estimatedCostUsd,
  };
}

async function loadEvalRunConfig(env, evalRunId) {
  if (!env.SESSIONS_DB) return null;
  const { results } = await env.SESSIONS_DB.prepare(
    'SELECT id, suite_id, models_json, judge_model, status FROM eval_runs WHERE id = ?1',
  ).bind(evalRunId).all();
  const row = results?.[0];
  if (!row) return null;
  const suite = getSuite(row.suite_id);
  if (!suite) return null;
  let models = [];
  try { models = JSON.parse(row.models_json || '[]'); } catch { models = []; }
  return {
    evalRunId,
    suite,
    models,
    judgeModel: row.judge_model,
    status: row.status,
  };
}

// ── Re-judge / regenerate helpers ─────────────────────────────────────────────
// These power the "Run judging" / "Continue judging" / per-cell retry buttons.
// They reuse the persisted RAG context KV key written by runOneQuery so the
// judge can be invoked without re-running the upstream pipeline.

async function loadVariantKvPayload(env, expId, varId) {
  if (!env.SESSION_STORE) return null;
  const raw = await env.SESSION_STORE.get(KV_KEY(expId, varId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function loadRagContext(env, expId) {
  if (!env.SESSION_STORE) return null;
  const raw = await env.SESSION_STORE.get(RAG_KV_KEY(expId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function loadVariantRow(env, variantId) {
  if (!env.SESSIONS_DB) return null;
  const { results } = await env.SESSIONS_DB.prepare(`
    SELECT id, experiment_id, provider, model, status, evaluator_score, evaluator_notes
    FROM experiment_variants WHERE id = ?1
  `).bind(variantId).all();
  return results?.[0] || null;
}

async function loadExperimentRow(env, experimentId) {
  if (!env.SESSIONS_DB) return null;
  const { results } = await env.SESSIONS_DB.prepare(`
    SELECT id, eval_run_id, eval_query_id, query, shared_intent_type, shared_journey_stage
    FROM experiments WHERE id = ?1
  `).bind(experimentId).all();
  return results?.[0] || null;
}

/**
 * Judge a single variant without re-running the pipeline. Loads blocks from KV,
 * loads the experiment's persisted RAG context, runs the judge, persists the
 * score + notes. Cheap — 1 Bedrock call, no LLM-generate.
 */
async function judgeOneVariantFromKv({
  env, variantId, judgeModel, signal,
}) {
  const variantRow = await loadVariantRow(env, variantId);
  if (!variantRow) throw new Error('Variant not found');
  if (variantRow.status !== 'complete') {
    throw new Error(`Variant generation not complete (status=${variantRow.status})`);
  }
  const expRow = await loadExperimentRow(env, variantRow.experiment_id);
  if (!expRow) throw new Error('Experiment not found for variant');

  const payload = await loadVariantKvPayload(env, variantRow.experiment_id, variantId);
  if (!payload || !Array.isArray(payload.blocks) || !payload.blocks.length) {
    throw new Error('Variant blocks not found in KV (payload missing or empty)');
  }
  const ragCtx = await loadRagContext(env, variantRow.experiment_id);

  // Look up the suite query def from the eval_run so we can pass expectedIntent
  // and expectedBehavior to the judge (these affect scoring for off-topic/decline
  // cases). Falls back gracefully if the eval_run row is missing.
  let queryDef = null;
  let runJudgeModel = judgeModel;
  if (expRow.eval_run_id) {
    const cfg = await loadEvalRunConfig(env, expRow.eval_run_id);
    if (cfg) {
      queryDef = cfg.suite.queries.find((q) => q.id === expRow.eval_query_id) || null;
      if (!runJudgeModel) runJudgeModel = cfg.judgeModel;
    }
  }
  if (!runJudgeModel) runJudgeModel = 'claude-sonnet-4-6';

  // Re-run assertions on the persisted blocks (idempotent, deterministic).
  const assertions = runAssertions(payload.blocks, queryDef || {});

  const result = await judgeVariant(env, {
    judgeModel: runJudgeModel,
    query: payload.request?.query || expRow.query || '',
    expectedIntent: queryDef?.expectedIntent || null,
    expectedBehavior: queryDef?.expectedBehavior || null,
    classifiedIntent: ragCtx?.intent?.type || expRow.shared_intent_type || null,
    journeyStage: ragCtx?.journeyStage || expRow.shared_journey_stage || null,
    rag: ragCtx?.rag || {},
    blocks: payload.blocks,
    signal,
  });
  const blockerInfo = detectBlocker(result.dims, assertions);
  if (env.SESSIONS_DB) {
    await writeVariantJudgeResult(env.SESSIONS_DB, variantId, result, assertions, blockerInfo);
  }
  return {
    variantId,
    experimentId: variantRow.experiment_id,
    queryId: expRow.eval_query_id,
    score: result.score,
    blocker: blockerInfo.blocker,
    blockerReasons: blockerInfo.reasons,
    summary: result.summary,
    dims: result.dims,
    judgeModel: result.judgeModel,
    judgeInputTokens: result.inputTokens,
    judgeOutputTokens: result.outputTokens,
    judgeDurationMs: result.durationMs,
    assertions,
  };
}

/**
 * Bulk judge phase across an entire eval run with shared concurrency limit.
 * Scope filters which variants are judged:
 *   pending — score IS NULL, status='complete', no judge_error in notes
 *   errors  — judge_error in notes (i.e. previous attempt failed)
 *   all     — every completed variant (force re-judge)
 * Streams NDJSON: judge-start, judge-done, judge-error, run-judge-done.
 */
async function findVariantsForScope(env, evalRunId, scope) {
  if (!env.SESSIONS_DB) return [];
  const baseSql = `
    SELECT v.id, v.experiment_id, v.provider, v.model, v.status,
           v.evaluator_score, v.evaluator_notes, e.eval_query_id
    FROM experiment_variants v
    JOIN experiments e ON v.experiment_id = e.id
    WHERE e.eval_run_id = ?1
  `;
  let where;
  if (scope === 'errors') {
    where = "AND v.evaluator_notes LIKE '%judge_error%'";
  } else if (scope === 'all') {
    where = "AND v.status = 'complete'";
  } else {
    // 'pending' default
    where = "AND v.status = 'complete' AND v.evaluator_score IS NULL AND (v.evaluator_notes IS NULL OR v.evaluator_notes NOT LIKE '%judge_error%')";
  }
  const { results } = await env.SESSIONS_DB.prepare(`${baseSql} ${where}`).bind(evalRunId).all();
  return results || [];
}

export async function judgeRunPendingStream(request, env, evalRunId, options = {}) {
  const cfg = await loadEvalRunConfig(env, evalRunId);
  if (!cfg) {
    return new Response(JSON.stringify({ error: 'Eval run not found' }), {
      status: 404,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  const scope = ['pending', 'errors', 'all'].includes(options.scope) ? options.scope : 'pending';
  let concurrency = typeof options.judgeConcurrency === 'number'
    ? Math.round(options.judgeConcurrency) : DEFAULT_REJUDGE_CONCURRENCY;
  concurrency = Math.max(1, Math.min(MAX_REJUDGE_CONCURRENCY, concurrency));

  const targets = await findVariantsForScope(env, evalRunId, scope);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const writeLine = async (obj) => {
    try { await writer.write(encoder.encode(`${JSON.stringify(obj)}\n`)); } catch { /* ignore */ }
  };

  const promise = (async () => {
    try {
      await writeLine({
        type: 'judge-start', evalRunId, scope, count: targets.length, concurrency,
      });
      await runWithConcurrency(targets, concurrency, async (t) => {
        await writeLine({
          type: 'variant-judge-start',
          variantId: t.id,
          experimentId: t.experiment_id,
          queryId: t.eval_query_id,
        });
        try {
          const result = await judgeOneVariantFromKv({
            env, variantId: t.id, judgeModel: cfg.judgeModel,
          });
          await writeLine({
            type: 'judge-done',
            variantId: t.id,
            experimentId: result.experimentId,
            queryId: result.queryId,
            score: result.score,
            blocker: result.blocker,
            blockerReasons: result.blockerReasons,
            summary: result.summary,
            dims: result.dims,
            judgeModel: result.judgeModel,
            judgeInputTokens: result.judgeInputTokens,
            judgeOutputTokens: result.judgeOutputTokens,
            judgeDurationMs: result.judgeDurationMs,
          });
        } catch (err) {
          const message = err.message || 'judge failed';
          console.error(`[Eval] re-judge failed (${t.id}):`, message);
          if (env.SESSIONS_DB) {
            try {
              await writeVariantJudgeError(env.SESSIONS_DB, t.id, message);
            } catch { /* ignore */ }
          }
          await writeLine({
            type: 'judge-error',
            variantId: t.id,
            experimentId: t.experiment_id,
            queryId: t.eval_query_id,
            message,
          });
        }
      });
      await writeLine({
        type: 'run-judge-done', evalRunId, scope, count: targets.length,
      });
    } catch (err) {
      await writeLine({ type: 'error', message: err.message || 'judge phase failed' });
    } finally {
      try { await writer.close(); } catch { /* already closed */ }
    }
  })();

  request.ctx?.waitUntil?.(promise);
  if (!request.ctx) promise.catch(() => {});

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
 * Re-judge a single variant. Returns JSON (no streaming — judge is short).
 */
export async function rejudgeOneVariant(env, evalRunId, variantId) {
  const cfg = await loadEvalRunConfig(env, evalRunId);
  if (!cfg) return { error: 'Eval run not found', status: 404 };
  try {
    const result = await judgeOneVariantFromKv({
      env, variantId, judgeModel: cfg.judgeModel,
    });
    return { ok: true, result };
  } catch (err) {
    const message = err.message || 'judge failed';
    if (env.SESSIONS_DB) {
      try {
        await writeVariantJudgeError(env.SESSIONS_DB, variantId, message);
      } catch { /* ignore */ }
    }
    return { ok: false, error: message };
  }
}

/**
 * Regenerate a single variant: re-runs upstream pipeline for its query,
 * regenerates the LLM output, runs assertions + judge. Updates the existing
 * variant row (no new row created). Streams NDJSON.
 */
export async function regenerateOneVariantStream(request, env, evalRunId, variantId) {
  const cfg = await loadEvalRunConfig(env, evalRunId);
  if (!cfg) {
    return new Response(JSON.stringify({ error: 'Eval run not found' }), {
      status: 404,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  const variantRow = await loadVariantRow(env, variantId);
  if (!variantRow) {
    return new Response(JSON.stringify({ error: 'Variant not found' }), {
      status: 404,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  const expRow = await loadExperimentRow(env, variantRow.experiment_id);
  if (!expRow || !expRow.eval_query_id) {
    return new Response(JSON.stringify({ error: 'Experiment / query not found' }), {
      status: 404,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  const queryDef = cfg.suite.queries.find((q) => q.id === expRow.eval_query_id);
  if (!queryDef) {
    return new Response(JSON.stringify({ error: 'Query not in suite' }), {
      status: 404,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  request.evalWriter = writer;
  request.evalEncoder = encoder;
  const writeLine = async (obj) => {
    try { await writer.write(encoder.encode(`${JSON.stringify(obj)}\n`)); } catch { /* ignore */ }
  };

  const promise = (async () => {
    try {
      await writeLine({
        type: 'regenerate-start',
        variantId,
        experimentId: variantRow.experiment_id,
        queryId: expRow.eval_query_id,
      });

      // Reset evaluator_* before regeneration so the matrix shows "in progress".
      if (env.SESSIONS_DB) {
        try {
          await env.SESSIONS_DB.prepare(`
            UPDATE experiment_variants
            SET status = 'running', evaluator_score = NULL, evaluator_notes = NULL,
                duration_ms = NULL, time_to_first_token_ms = NULL,
                input_tokens = NULL, output_tokens = NULL, title = NULL,
                block_count = NULL, error = NULL
            WHERE id = ?1
          `).bind(variantId).run();
        } catch (dbErr) {
          console.error('[Eval] regenerate D1 reset failed:', dbErr.message);
        }
      }

      // Build a fresh ctx for this query — same as runOneQuery does.
      const ctx = createContext({ query: queryDef.query }, request);
      const flow = resolveFlow('default');
      ctx.flowId = flow.id;
      ctx.flowName = flow.name || flow.id;
      ctx.writer = writer;
      ctx.encoder = encoder;
      ctx.timings.steps = [];

      const gateSteps = flow.steps.filter((s) => s.gate);
      for (let gi = 0; gi < gateSteps.length; gi += 1) {
        if (ctx.earlyResponse) break;
        const s = gateSteps[gi];
        // eslint-disable-next-line no-await-in-loop
        await STEPS[s.step](ctx, s.config || {}, env);
      }
      if (ctx.earlyResponse) {
        await writeLine({ type: 'regenerate-error', variantId, message: 'gated before pipeline' });
        return;
      }

      const upstreamSteps = flow.steps.filter(
        (s) => !s.gate && !(s.step === 'llm-generate'),
      );
      await executeFlow(upstreamSteps, ctx, env);

      const heroImage = selectHeroImage({
        query: ctx.request?.query,
        useCases: ctx.rag?.useCase?.useCases,
        intentType: ctx.intent?.type,
        productIds: extractProductIds(ctx.request?.query || ''),
      }, ctx.rag?.heroImages || []);
      setHeroResult(heroImage);

      // Refresh persisted RAG context to match the new pipeline run.
      if (env.SESSION_STORE) {
        try {
          await env.SESSION_STORE.put(
            RAG_KV_KEY(variantRow.experiment_id),
            JSON.stringify({
              rag: ctx.rag || {},
              intent: ctx.intent || null,
              journeyStage: ctx.request?.inferredProfile?.journeyStage || null,
              query: queryDef.query,
              queryId: queryDef.id,
            }),
            { expirationTtl: VARIANT_KV_TTL },
          );
        } catch (kvErr) {
          console.error('[Eval] RAG context KV refresh failed:', kvErr.message);
        }
      }

      // Re-run the LLM step against the existing variant row.
      const resolved = resolveLlmConfig(
        {
          provider: variantRow.provider,
          model: variantRow.model,
          temperature: null,
          maxTokens: null,
        },
        flow.steps.find((s) => s.step === 'llm-generate')?.config || {},
      );
      const variant = {
        id: variantId,
        experimentId: variantRow.experiment_id,
        variantIndex: 0,
        provider: resolved.provider,
        model: resolved.model,
        temperature: resolved.temperature,
        maxTokens: resolved.maxTokens,
        state: createVariantState(),
        timings: {},
        status: 'running',
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
        ttftMs: null,
        title: null,
      };

      try {
        const { title } = await runLlmVariant(ctx, env, {
          variantId,
          provider: variant.provider,
          model: variant.model,
          temperature: variant.temperature,
          maxTokens: variant.maxTokens,
          out: variant.state,
          timings: variant.timings,
          emitDebug: false,
          emitDone: false,
        });
        variant.finishedAt = Date.now();
        variant.status = 'complete';
        variant.title = title || extractTitle(variant.state.sections[0] || '');
        variant.ttftMs = (variant.timings.llmFirstToken && variant.timings.llmStart)
          ? variant.timings.llmFirstToken - variant.timings.llmStart
          : null;
      } catch (err) {
        variant.finishedAt = Date.now();
        variant.status = 'error';
        variant.error = err.message || 'variant failed';
      }

      // Persist KV payload + finalize variant row.
      if (env.SESSION_STORE) {
        try {
          const payload = buildVariantPayload(ctx, variant);
          await env.SESSION_STORE.put(
            KV_KEY(variantRow.experiment_id, variantId),
            JSON.stringify(payload),
            { expirationTtl: VARIANT_KV_TTL },
          );
        } catch (kvErr) {
          console.error(`[Eval] regen KV write failed (${variantId}):`, kvErr.message);
        }
      }
      if (env.SESSIONS_DB) {
        try {
          await finalizeVariantRow(env.SESSIONS_DB, {
            id: variantId,
            status: variant.status,
            durationMs: variant.finishedAt && variant.startedAt
              ? variant.finishedAt - variant.startedAt : null,
            ttftMs: variant.ttftMs ?? null,
            inputTokens: variant.state.usage?.prompt_tokens || null,
            outputTokens: variant.state.usage?.completion_tokens || null,
            title: variant.title,
            blockCount: variant.state.sections.length,
            error: variant.error,
          });
        } catch (dbErr) {
          console.error('[Eval] regen finalize failed:', dbErr.message);
        }
      }

      await writeLine({
        type: 'variant-done',
        variantId,
        experimentId: variantRow.experiment_id,
        queryId: queryDef.id,
        durationMs: variant.finishedAt && variant.startedAt
          ? variant.finishedAt - variant.startedAt : null,
        ttftMs: variant.ttftMs,
        inputTokens: variant.state.usage?.prompt_tokens || 0,
        outputTokens: variant.state.usage?.completion_tokens || 0,
        title: variant.title,
        blockCount: variant.state.sections.length,
        status: variant.status,
        error: variant.error,
      });

      if (variant.status !== 'complete') return;

      // Run assertions + judge directly using the fresh ctx (no need to round-trip KV).
      const blocks = variant.state.sections.map((html, i) => ({
        index: i,
        blockType: variant.state.rawJsonSections?.[i]?.block || 'unknown',
        html,
      }));
      const assertions = runAssertions(blocks, queryDef);
      try {
        const result = await judgeVariant(env, {
          judgeModel: cfg.judgeModel,
          query: queryDef.query,
          expectedIntent: queryDef.expectedIntent || null,
          expectedBehavior: queryDef.expectedBehavior || null,
          classifiedIntent: ctx.intent?.type || null,
          journeyStage: ctx.request?.inferredProfile?.journeyStage || null,
          rag: ctx.rag || {},
          blocks,
        });
        const blockerInfo = detectBlocker(result.dims, assertions);
        if (env.SESSIONS_DB) {
          await writeVariantJudgeResult(
            env.SESSIONS_DB,
            variantId,
            result,
            assertions,
            blockerInfo,
          );
        }
        await writeLine({
          type: 'judge-done',
          variantId,
          experimentId: variantRow.experiment_id,
          queryId: queryDef.id,
          score: result.score,
          blocker: blockerInfo.blocker,
          blockerReasons: blockerInfo.reasons,
          summary: result.summary,
          dims: result.dims,
          judgeModel: result.judgeModel,
          judgeInputTokens: result.inputTokens,
          judgeOutputTokens: result.outputTokens,
          judgeDurationMs: result.durationMs,
        });
      } catch (err) {
        const message = err.message || 'judge failed';
        if (env.SESSIONS_DB) {
          try {
            await writeVariantJudgeError(env.SESSIONS_DB, variantId, message);
          } catch { /* ignore */ }
        }
        await writeLine({
          type: 'judge-error',
          variantId,
          experimentId: variantRow.experiment_id,
          queryId: queryDef.id,
          message,
        });
      }
    } catch (err) {
      console.error('[Eval] regenerate failed:', err);
      await writeLine({ type: 'regenerate-error', variantId, message: err.message || 'regenerate failed' });
    } finally {
      try { await writer.close(); } catch { /* already closed */ }
    }
  })();

  request.ctx?.waitUntil?.(promise);
  if (!request.ctx) promise.catch(() => {});

  return new Response(readable, {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    },
  });
}

export async function runEvalQueryStream(request, env, evalRunId, queryId, options = {}) {
  const skipJudge = options.skipJudge === true;
  const cfg = await loadEvalRunConfig(env, evalRunId);
  if (!cfg) {
    return new Response(JSON.stringify({ error: 'Eval run not found' }), {
      status: 404,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  const queryDef = cfg.suite.queries.find((q) => q.id === queryId);
  if (!queryDef) {
    return new Response(JSON.stringify({ error: `Query ${queryId} not in suite ${cfg.suite.id}` }), {
      status: 404,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  request.evalWriter = writer;
  request.evalEncoder = encoder;

  const writeLine = async (obj) => {
    try {
      await writer.write(encoder.encode(`${JSON.stringify(obj)}\n`));
    } catch (err) {
      console.error('[Eval] writeLine failed:', err.message);
    }
  };

  const promise = (async () => {
    try {
      await runOneQuery({
        env,
        request,
        query: queryDef.query,
        queryDef,
        models: cfg.models,
        evalRunId,
        judgeModel: cfg.judgeModel,
        writeLine,
        skipJudge,
      });
    } catch (err) {
      console.error('[Eval] runOneQuery failed:', err);
      await writeLine({
        type: 'query-error',
        queryId: queryDef.id,
        message: err.message || 'query failed',
      });
    } finally {
      try { await writer.close(); } catch { /* already closed */ }
    }
  })();

  request.ctx?.waitUntil?.(promise);
  if (!request.ctx) promise.catch(() => {});

  return new Response(readable, {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    },
  });
}

function parseEvalNotes(notesJson) {
  if (!notesJson) return null;
  try { return JSON.parse(notesJson); } catch { return null; }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Standard error of the mean and 95% confidence half-width using a normal
// approximation (z=1.96). Adequate for n≥30; for smaller n we still report it
// — it widens with small samples, which is the desired signal.
function meanCi(values) {
  const n = values.length;
  if (n === 0) {
    return {
      mean: null, sem: null, ci95: null, n: 0,
    };
  }
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) {
    return {
      mean: round2(mean), sem: null, ci95: null, n,
    };
  }
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1);
  const sem = Math.sqrt(variance / n);
  return {
    mean: round2(mean),
    sem: round2(sem),
    ci95: round2(1.96 * sem),
    n,
  };
}

function buildSummaryFromD1(models, experiments, variants) {
  const expById = new Map(experiments.map((e) => [e.id, e]));
  const perModel = new Map();
  models.forEach((m) => {
    const key = `${m.provider}::${m.model}`;
    perModel.set(key, {
      provider: m.provider,
      model: m.model,
      label: m.label,
      generations: 0,
      qualityValues: [],
      structureValues: [],
      intentValues: [],
      faithfulnessValues: [],
      helpfulnessValues: [],
      brandVoiceValues: [],
      specificityValues: [],
      visualAssetUsageValues: [],
      ttftValues: [],
      durationValues: [],
      inputTokenSum: 0,
      outputTokenSum: 0,
      blockerCount: 0,
      assertionFailCount: 0,
      assertionGradedCount: 0,
      errors: 0,
    });
  });

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let judgeInputTokens = 0;
  let judgeOutputTokens = 0;

  variants.forEach((v) => {
    if (!expById.has(v.experiment_id)) return;
    const key = `${v.provider}::${v.model}`;
    const bucket = perModel.get(key);
    if (!bucket) return;
    bucket.generations += 1;
    if (v.status !== 'complete') {
      bucket.errors += 1;
      return;
    }
    if (v.time_to_first_token_ms != null) bucket.ttftValues.push(v.time_to_first_token_ms);
    if (v.duration_ms != null) bucket.durationValues.push(v.duration_ms);
    bucket.inputTokenSum += v.input_tokens || 0;
    bucket.outputTokenSum += v.output_tokens || 0;
    totalInputTokens += v.input_tokens || 0;
    totalOutputTokens += v.output_tokens || 0;

    const notes = parseEvalNotes(v.evaluator_notes);
    if (notes?.assertions) {
      bucket.assertionGradedCount += 1;
      if (notes.assertions.passed === false) bucket.assertionFailCount += 1;
    }
    if (notes?.blocker) bucket.blockerCount += 1;
    if (notes && !notes.judge_error && v.evaluator_score != null) {
      bucket.qualityValues.push(v.evaluator_score);
      if (notes.structure?.score) bucket.structureValues.push(notes.structure.score);
      if (notes.intent?.score) bucket.intentValues.push(notes.intent.score);
      if (notes.faithfulness?.score) bucket.faithfulnessValues.push(notes.faithfulness.score);
      if (notes.helpfulness?.score) bucket.helpfulnessValues.push(notes.helpfulness.score);
      if (notes.brandVoice?.score) bucket.brandVoiceValues.push(notes.brandVoice.score);
      if (notes.specificity?.score) bucket.specificityValues.push(notes.specificity.score);
      if (notes.visualAssetUsage?.score) {
        bucket.visualAssetUsageValues.push(notes.visualAssetUsage.score);
      }
      judgeInputTokens += notes.judge_input_tokens || 0;
      judgeOutputTokens += notes.judge_output_tokens || 0;
    }
  });

  const summary = [...perModel.values()].map((b) => {
    const quality = meanCi(b.qualityValues);
    const ttft = meanCi(b.ttftValues);
    const duration = meanCi(b.durationValues);
    const blockerRate = b.generations
      ? round2((b.blockerCount / b.generations) * 100) / 100 : null;
    return {
      provider: b.provider,
      model: b.model,
      label: b.label,
      generations: b.generations,
      errors: b.errors,
      avgTtftMs: ttft.mean != null ? Math.round(ttft.mean) : null,
      ttftCi95: ttft.ci95 != null ? Math.round(ttft.ci95) : null,
      avgDurationMs: duration.mean != null ? Math.round(duration.mean) : null,
      durationCi95: duration.ci95 != null ? Math.round(duration.ci95) : null,
      inputTokens: b.inputTokenSum,
      outputTokens: b.outputTokenSum,
      avgQuality: quality.mean,
      qualityCi95: quality.ci95,
      qualityN: quality.n,
      avgStructure: meanCi(b.structureValues).mean,
      avgIntent: meanCi(b.intentValues).mean,
      avgFaithfulness: meanCi(b.faithfulnessValues).mean,
      avgHelpfulness: meanCi(b.helpfulnessValues).mean,
      avgBrandVoice: meanCi(b.brandVoiceValues).mean,
      avgSpecificity: meanCi(b.specificityValues).mean,
      avgVisualAssetUsage: meanCi(b.visualAssetUsageValues).mean,
      blockerCount: b.blockerCount,
      blockerRate,
      assertionFailCount: b.assertionFailCount,
      assertionGradedCount: b.assertionGradedCount,
    };
  });

  return {
    perModel: summary,
    totalInputTokens,
    totalOutputTokens,
    judgeInputTokens,
    judgeOutputTokens,
  };
}

export async function finalizeEvalRun(env, evalRunId) {
  if (!env.SESSIONS_DB) return { error: 'D1 not configured' };

  const { results: runRows } = await env.SESSIONS_DB.prepare(
    'SELECT id, suite_id, models_json, status FROM eval_runs WHERE id = ?1',
  ).bind(evalRunId).all();
  const runRow = runRows?.[0];
  if (!runRow) return { error: 'Eval run not found' };

  let models = [];
  try { models = JSON.parse(runRow.models_json || '[]'); } catch { models = []; }

  const { results: experiments } = await env.SESSIONS_DB.prepare(
    'SELECT id, eval_query_id, status FROM experiments WHERE eval_run_id = ?1',
  ).bind(evalRunId).all();

  let variants = [];
  if (experiments.length) {
    const expIds = experiments.map((e) => e.id);
    const placeholders = expIds.map((_, i) => `?${i + 1}`).join(', ');
    const { results } = await env.SESSIONS_DB.prepare(`
      SELECT experiment_id, provider, model, status, duration_ms, time_to_first_token_ms,
             input_tokens, output_tokens, evaluator_score, evaluator_notes
      FROM experiment_variants
      WHERE experiment_id IN (${placeholders})
    `).bind(...expIds).all();
    variants = results;
  }

  const summary = buildSummaryFromD1(models, experiments, variants);
  const anyComplete = variants.some((v) => v.status === 'complete');
  const status = anyComplete ? 'complete' : 'error';

  await finalizeEvalRunRow(env.SESSIONS_DB, {
    id: evalRunId,
    status,
    totalInputTokens: summary.totalInputTokens,
    totalOutputTokens: summary.totalOutputTokens,
    judgeInputTokens: summary.judgeInputTokens,
    judgeOutputTokens: summary.judgeOutputTokens,
    summaryJson: { perModel: summary.perModel },
    error: anyComplete ? null : 'no completed variants',
  });

  return {
    evalRunId,
    status,
    summary: summary.perModel,
    totalInputTokens: summary.totalInputTokens,
    totalOutputTokens: summary.totalOutputTokens,
    judgeInputTokens: summary.judgeInputTokens,
    judgeOutputTokens: summary.judgeOutputTokens,
  };
}

// ── Constants for the admin form ──────────────────────────────────────────────

export { JUDGE_MODELS };
