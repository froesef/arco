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

const VARIANT_KV_TTL = 60 * 60 * 24 * 90; // 90 days
const JUDGE_CONCURRENCY = 4;
const KV_KEY = (expId, varId) => `experiment:${expId}:variant:${varId}`;

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

  return {
    payload: {
      suite,
      models,
      judgeModel,
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

async function writeVariantJudgeResult(db, variantId, judgement) {
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
  env, request, query, queryDef, models, evalRunId, judgeModel, writeLine,
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

  // Judge — concurrency-limited, only completed variants.
  const judgeable = variants.filter((v) => v.status === 'complete' && v.state.sections.length > 0);
  const judgements = await runWithConcurrency(judgeable, JUDGE_CONCURRENCY, async (v) => {
    try {
      const result = await judgeVariant(env, {
        judgeModel,
        query,
        expectedIntent: queryDef.expectedIntent || null,
        classifiedIntent: intentType,
        journeyStage,
        rag: ctx.rag || {},
        blocks: v.state.sections.map((html, i) => ({
          index: i,
          blockType: v.state.rawJsonSections?.[i]?.block || 'unknown',
          html,
        })),
      });
      if (env.SESSIONS_DB) {
        await writeVariantJudgeResult(env.SESSIONS_DB, v.id, result);
      }
      await writeLine({
        type: 'judge-done',
        queryId: queryDef.id,
        experimentId,
        variantId: v.id,
        score: result.score,
        summary: result.summary,
        dims: result.dims,
        judgeModel: result.judgeModel,
        judgeInputTokens: result.inputTokens,
        judgeOutputTokens: result.outputTokens,
        judgeDurationMs: result.durationMs,
      });
      return result;
    } catch (err) {
      const message = err.message || 'judge failed';
      console.error(`[Eval] judge failed (${v.id}):`, message);
      if (env.SESSIONS_DB) {
        try { await writeVariantJudgeError(env.SESSIONS_DB, v.id, message); } catch { /* ignore */ }
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

// ── Summary aggregation ──────────────────────────────────────────────────────

function buildSummary(models, queryResults) {
  const perModel = new Map();
  models.forEach((m) => {
    const key = `${m.provider}::${m.model}`;
    perModel.set(key, {
      provider: m.provider,
      model: m.model,
      label: m.label,
      generations: 0,
      ttftSum: 0,
      ttftCount: 0,
      durationSum: 0,
      durationCount: 0,
      inputTokenSum: 0,
      outputTokenSum: 0,
      qualitySum: 0,
      qualityCount: 0,
      structureSum: 0,
      intentSum: 0,
      faithfulnessSum: 0,
      helpfulnessSum: 0,
      errors: 0,
    });
  });

  queryResults.forEach((qr) => {
    if (!qr) return;
    qr.variants.forEach((v, i) => {
      const key = `${v.provider}::${v.model}`;
      const bucket = perModel.get(key);
      if (!bucket) return;
      bucket.generations += 1;
      if (v.status !== 'complete') {
        bucket.errors += 1;
        return;
      }
      if (v.ttftMs != null) { bucket.ttftSum += v.ttftMs; bucket.ttftCount += 1; }
      if (v.startedAt && v.finishedAt) {
        bucket.durationSum += v.finishedAt - v.startedAt;
        bucket.durationCount += 1;
      }
      bucket.inputTokenSum += v.state.usage?.prompt_tokens || 0;
      bucket.outputTokenSum += v.state.usage?.completion_tokens || 0;

      const judge = qr.judgements[i];
      if (judge && !judge.error) {
        bucket.qualitySum += judge.score;
        bucket.qualityCount += 1;
        bucket.structureSum += judge.dims.structure.score || 0;
        bucket.intentSum += judge.dims.intent.score || 0;
        bucket.faithfulnessSum += judge.dims.faithfulness.score || 0;
        bucket.helpfulnessSum += judge.dims.helpfulness.score || 0;
      }
    });
  });

  return [...perModel.values()].map((b) => ({
    provider: b.provider,
    model: b.model,
    label: b.label,
    generations: b.generations,
    errors: b.errors,
    avgTtftMs: b.ttftCount ? Math.round(b.ttftSum / b.ttftCount) : null,
    avgDurationMs: b.durationCount ? Math.round(b.durationSum / b.durationCount) : null,
    inputTokens: b.inputTokenSum,
    outputTokens: b.outputTokenSum,
    avgQuality: b.qualityCount ? Math.round((b.qualitySum / b.qualityCount) * 100) / 100 : null,
    avgStructure: b.qualityCount ? Math.round((b.structureSum / b.qualityCount) * 100) / 100 : null,
    avgIntent: b.qualityCount ? Math.round((b.intentSum / b.qualityCount) * 100) / 100 : null,
    avgFaithfulness: b.qualityCount
      ? Math.round((b.faithfulnessSum / b.qualityCount) * 100) / 100 : null,
    avgHelpfulness: b.qualityCount
      ? Math.round((b.helpfulnessSum / b.qualityCount) * 100) / 100 : null,
  }));
}

// ── Public entry point ───────────────────────────────────────────────────────

export async function startEvalRun(request, env, payload) {
  const { suite, models, judgeModel } = payload;
  const evalRunId = crypto.randomUUID();
  const variantCount = suite.queries.length * models.length;
  const estimatedCostUsd = estimateJudgeCost({
    queryCount: suite.queries.length,
    modelCount: models.length,
    judgeModel,
  });

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  // Stash on the request so per-query ctx instances share the same writer.
  request.evalWriter = writer;
  request.evalEncoder = encoder;

  const writeLine = async (obj) => {
    try {
      await writer.write(encoder.encode(`${JSON.stringify(obj)}\n`));
    } catch (err) {
      console.error('[Eval] writeLine failed:', err.message);
    }
  };

  const streamPromise = (async () => {
    let runStatus = 'complete';
    let runError = null;
    const queryResults = [];
    let totalGenInput = 0;
    let totalGenOutput = 0;
    let totalJudgeInput = 0;
    let totalJudgeOutput = 0;

    try {
      if (env.SESSIONS_DB) {
        try {
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
        } catch (dbErr) {
          console.error('[Eval] eval_run insert failed:', dbErr.message);
        }
      }

      await writeLine({
        type: 'run-start',
        evalRunId,
        suiteId: suite.id,
        suiteName: suite.name,
        queryCount: suite.queries.length,
        modelCount: models.length,
        variantCount,
        judgeModel,
        estimatedCostUsd,
      });

      // Sequential across queries so we don't blow Vectorize / RAG concurrency.
      for (let qi = 0; qi < suite.queries.length; qi += 1) {
        const queryDef = suite.queries[qi];
        // eslint-disable-next-line no-await-in-loop
        const qr = await runOneQuery({
          env,
          request,
          query: queryDef.query,
          queryDef,
          models,
          evalRunId,
          judgeModel,
          writeLine,
        });
        queryResults.push(qr);
        if (qr) {
          totalGenInput += qr.generationInputTokens;
          totalGenOutput += qr.generationOutputTokens;
          totalJudgeInput += qr.judgeInputTokens;
          totalJudgeOutput += qr.judgeOutputTokens;
        }
      }

      const summary = buildSummary(models, queryResults);
      if (env.SESSIONS_DB) {
        try {
          await finalizeEvalRunRow(env.SESSIONS_DB, {
            id: evalRunId,
            status: runStatus,
            totalInputTokens: totalGenInput,
            totalOutputTokens: totalGenOutput,
            judgeInputTokens: totalJudgeInput,
            judgeOutputTokens: totalJudgeOutput,
            summaryJson: { perModel: summary },
          });
        } catch (dbErr) {
          console.error('[Eval] eval_run finalize failed:', dbErr.message);
        }
      }

      await writeLine({
        type: 'run-done',
        evalRunId,
        status: runStatus,
        summary,
        totalInputTokens: totalGenInput,
        totalOutputTokens: totalGenOutput,
        judgeInputTokens: totalJudgeInput,
        judgeOutputTokens: totalJudgeOutput,
      });
    } catch (err) {
      runStatus = 'error';
      runError = err.message || 'eval run failed';
      console.error('[Eval] run failed:', err);
      if (env.SESSIONS_DB) {
        try {
          await finalizeEvalRunRow(env.SESSIONS_DB, {
            id: evalRunId,
            status: 'error',
            totalInputTokens: totalGenInput,
            totalOutputTokens: totalGenOutput,
            judgeInputTokens: totalJudgeInput,
            judgeOutputTokens: totalJudgeOutput,
            summaryJson: null,
            error: runError,
          });
        } catch { /* ignore */ }
      }
      await writeLine({ type: 'error', message: runError });
    } finally {
      try { await writer.close(); } catch { /* already closed */ }
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

// ── Constants for the admin form ──────────────────────────────────────────────

export { JUDGE_MODELS };
