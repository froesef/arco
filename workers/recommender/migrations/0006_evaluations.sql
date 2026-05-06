-- LLM Evaluation runs — multi-query × multi-model batches with Claude-as-judge.
--
-- Each eval_run rolls up many `experiments` rows (one per query in the suite).
-- Every experiment in an eval_run has the same N variants (one per model under
-- test). Per-variant quality scores are written into the existing
-- `experiment_variants.evaluator_*` columns reserved by migration 0004.
--
-- Notes:
--   - We don't add a separate eval_results table. The (query × model) grid
--     reuses existing experiment + experiment_variant rows. Joining on
--     experiments.eval_run_id + eval_query_id is enough to drive the matrix UI.
--   - eval_run_id is nullable on experiments so existing ad-hoc experiments are
--     unaffected (they keep eval_run_id IS NULL).

CREATE TABLE IF NOT EXISTS eval_runs (
  id                  TEXT PRIMARY KEY,
  suite_id            TEXT NOT NULL,
  suite_name          TEXT NOT NULL,
  suite_version       INTEGER,                  -- copied from suite JSON for reproducibility
  models_json         TEXT NOT NULL,            -- [{provider, model, temperature, maxTokens, label}]
  judge_provider      TEXT NOT NULL,            -- 'anthropic'
  judge_model         TEXT NOT NULL,            -- e.g. 'claude-sonnet-4-6'
  status              TEXT NOT NULL,            -- 'running' | 'complete' | 'error'
  created_at          INTEGER NOT NULL,
  completed_at        INTEGER,
  query_count         INTEGER NOT NULL,
  model_count         INTEGER NOT NULL,
  variant_count       INTEGER NOT NULL,         -- query_count * model_count
  total_input_tokens  INTEGER,                  -- generation tokens, summed
  total_output_tokens INTEGER,
  judge_input_tokens  INTEGER,                  -- judge tokens, summed
  judge_output_tokens INTEGER,
  estimated_cost_usd  REAL,                     -- best-effort, from RATES table at run time
  summary_json        TEXT,                     -- per-model aggregate snapshot
  error               TEXT
);

CREATE INDEX IF NOT EXISTS idx_eval_runs_created
  ON eval_runs(created_at DESC);

-- Tag every experiment row with the eval run + query it belongs to.
ALTER TABLE experiments ADD COLUMN eval_run_id TEXT REFERENCES eval_runs(id);
ALTER TABLE experiments ADD COLUMN eval_query_id TEXT;

CREATE INDEX IF NOT EXISTS idx_experiments_eval_run
  ON experiments(eval_run_id);
