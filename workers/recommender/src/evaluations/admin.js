/**
 * Admin route handlers for the LLM Evaluation tab.
 *
 *   GET  /api/admin/eval-suites           — bundled coffee suite(s) + judge models
 *   POST /api/admin/evaluations           — start a run (NDJSON stream)
 *   GET  /api/admin/evaluations           — paginated list of runs
 *   GET  /api/admin/evaluations/:id       — run detail (rows + per-query experiments)
 */

import { CORS_HEADERS } from '../pipeline/context.js';
import { requireAdminAuth } from '../admin.js';
import { listSuites, getSuite } from './suites.js';
import { JUDGE_MODELS } from './judge.js';
import { validateRunBody, startEvalRun } from './runner.js';

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

// ── GET /api/admin/eval-suites ────────────────────────────────────────────────

export async function handleListEvalSuites(request, env) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (id) {
    const suite = getSuite(id);
    if (!suite) return jsonResponse({ error: 'Suite not found' }, { status: 404 });
    return jsonResponse({ suite, judgeModels: JUDGE_MODELS });
  }
  return jsonResponse({ suites: listSuites(), judgeModels: JUDGE_MODELS });
}

// ── POST /api/admin/evaluations ───────────────────────────────────────────────

export async function handleCreateEvaluation(request, env) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;

  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const validation = validateRunBody(rawBody, env);
  if (validation.error) return jsonResponse({ error: validation.error }, { status: 400 });

  return startEvalRun(request, env, validation.payload);
}

// ── GET /api/admin/evaluations ────────────────────────────────────────────────

export async function handleListEvaluations(request, env) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;
  if (!env.SESSIONS_DB) {
    return jsonResponse({
      runs: [], total: 0, limit: 0, offset: 0,
    });
  }

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const { results: runs } = await env.SESSIONS_DB.prepare(`
    SELECT id, suite_id, suite_name, suite_version, models_json, judge_model,
           status, created_at, completed_at,
           query_count, model_count, variant_count,
           total_input_tokens, total_output_tokens,
           judge_input_tokens, judge_output_tokens, estimated_cost_usd,
           summary_json, error
    FROM eval_runs
    ORDER BY created_at DESC
    LIMIT ?1 OFFSET ?2
  `).bind(limit, offset).all();

  const { results: countRow } = await env.SESSIONS_DB.prepare(
    'SELECT COUNT(*) as total FROM eval_runs',
  ).all();

  return jsonResponse({
    runs,
    total: countRow[0]?.total || 0,
    limit,
    offset,
  });
}

// ── GET /api/admin/evaluations/:id ────────────────────────────────────────────

export async function handleGetEvaluation(request, env, evalRunId) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;
  if (!env.SESSIONS_DB) {
    return jsonResponse({ error: 'D1 not configured' }, { status: 500 });
  }

  const { results: [run] } = await env.SESSIONS_DB.prepare(
    'SELECT * FROM eval_runs WHERE id = ?1',
  ).bind(evalRunId).all();
  if (!run) return jsonResponse({ error: 'Eval run not found' }, { status: 404 });

  const { results: experiments } = await env.SESSIONS_DB.prepare(`
    SELECT id, eval_query_id, query, status, created_at, completed_at,
           shared_intent_type, shared_journey_stage, shared_duration_ms
    FROM experiments
    WHERE eval_run_id = ?1
    ORDER BY created_at ASC
  `).bind(evalRunId).all();

  const expIds = experiments.map((e) => e.id);
  let variants = [];
  if (expIds.length) {
    // SQLite doesn't allow array binding directly; build a placeholder list.
    const placeholders = expIds.map((_, i) => `?${i + 1}`).join(', ');
    const { results } = await env.SESSIONS_DB.prepare(`
      SELECT id, experiment_id, variant_index, provider, model, temperature,
             max_tokens, status, duration_ms, time_to_first_token_ms,
             input_tokens, output_tokens, title, block_count, error,
             evaluator_score, evaluator_notes
      FROM experiment_variants
      WHERE experiment_id IN (${placeholders})
      ORDER BY experiment_id ASC, variant_index ASC
    `).bind(...expIds).all();
    variants = results;
  }

  // Reuse the suite definition so the matrix knows query order + expected intents.
  const suite = getSuite(run.suite_id);

  return jsonResponse({
    run, suite, experiments, variants,
  });
}
