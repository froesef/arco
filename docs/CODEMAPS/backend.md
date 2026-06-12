<!-- Generated: 2026-06-12 | Files scanned: 30+ | Token estimate: ~1100 -->

# Backend Architecture — Cloudflare Worker (Recommender)

## Entry Point

`workers/recommender/src/index.js` — routes every HTTP request (`fetch`), the CF Queue consumer (`queue`), and the cron scheduled trigger (`scheduled`). Worker name: `arco-recommender`; production URL `https://arco-recommender.franklin-prod.workers.dev`. Branch versions deploy to `https://{alias}-arco-recommender.franklin-prod.workers.dev` via `wrangler versions upload --preview-alias` (see `deploy-branch.sh`).

## Public HTTP Routes

```
GET  /api/health                 → handleHealth()           healthcheck
POST /api/generate               → handleGenerate()         SSE stream — runs pipeline, persists run
POST /api/suggest                → handleSuggest()          keep-exploring follow-up suggestions
POST /api/persist                → handlePersist()          persist DA page (legacy, called after confirm)
POST /api/feedback               → handleSubmitFeedback()   public; upserts run_feedback (rating, comment, flags)
POST /api/track                  → handleTrack()            analytics event capture
GET  /api/stats                  → handleStats()            aggregate analytics stats
GET  /api/debug/search           → handleDebugSearch()      RAG search debug (intentionally not auth-gated)
GET  /admin                      → handleAdminUI()          server-rendered admin SPA (legacy, now superseded by /admin block)
```

CORS is permissive on public routes; admin routes are gated by HTTP Basic auth against `ADMIN_TOKEN`.

## Admin HTTP Routes (Basic auth)

All require `Authorization: Basic base64("admin:$ADMIN_TOKEN")`.

```
# Sessions / Pages / Runs
GET  /api/admin/sessions
GET  /api/admin/sessions/:id
GET  /api/admin/pages/:id
GET  /api/admin/runs/:id

# Model catalog + active model selection
GET  /api/admin/catalog                              → { catalog, limits }
GET  /api/admin/llm-config                           → { active }
PUT  /api/admin/llm-config                           → set {provider, model, temperature, maxTokens}

# Experiments (multi-model A/B for one query, parallel variants)
GET  /api/admin/experiments                          → list (paginated)
POST /api/admin/experiments                          → create + stream NDJSON
GET  /api/admin/experiments/:id                      → exp + variants
GET  /api/admin/experiments/:id/variants/:variantId  → variant payload (blocks + debug)

# LLM Evaluations (matrix: query suite × model list × Claude judge)
GET  /api/admin/eval-suites                          → bundled suites + judge models
GET  /api/admin/evaluations                          → list (paginated)
POST /api/admin/evaluations                          → create eval_run row only (legacy)
POST /api/admin/evaluations/start                    → create + publish queue messages (primary entry)
GET  /api/admin/evaluations/:id                      → run + experiments + variants (?include=feedback)
GET  /api/admin/evaluations/:id/progress             → lightweight polling payload
POST /api/admin/evaluations/:id/resume               → re-publish queue messages for missing/failed queries
POST /api/admin/evaluations/:id/queries              → run one query inline (NDJSON, legacy/cron)
POST /api/admin/evaluations/:id/judge                → bulk judge inline (NDJSON, legacy/cron)
POST /api/admin/evaluations/:id/variants/:vid/rejudge    → publish single rejudge message
POST /api/admin/evaluations/:id/variants/:vid/regenerate → publish single regenerate message
POST /api/admin/evaluations/:id/finalize             → recompute summary + close run

# Eval Queue ops/diagnostics
GET  /api/admin/eval-queue                           → backlog stats from CF Queues API
GET  /api/admin/eval-queue/consumers                 → consumer registration + delivery_paused
POST /api/admin/eval-queue/purge                     → drop all pending messages
POST /api/admin/eval-queue/resume-delivery           → un-pause delivery
POST /api/admin/eval-queue/test-invoke               → synthesize a batch + invoke consumer directly

# Vectorize inspector
GET  /api/admin/vectorize/stats                      → index stats + sampled histogram
GET  /api/admin/vectorize/search?q=...&k=N           → k-NN search over arco-content

# Feedback (admin views)
GET  /api/admin/feedback                             → list with filters (rating/flag/model/q/hasComment/since/until)
GET  /api/admin/feedback/summary                     → header-strip aggregates + judge↔user divergence
GET  /api/admin/feedback/run/:runId                  → single-run detail + per-flag/per-product counts
GET  /api/admin/feedback/export?format=csv|json      → flattened export, streaming
```

## Pipeline Architecture

### Flow Definition (`src/pipeline/flows.js`)

Single flow: `recommender` (aka `default`). Each step is sequential or `{ parallel: [...] }`.

```
safety-gate (rejects off-topic queries before any RAG/LLM)
  → rate-limit (gate)
  → analyze-behavior
  → intent-classify
  → [persona-match ‖ use-case-match]
  → rag-products (maxResults: 8)
  → [rag-content ‖ rag-features ‖ rag-reviews ‖ rag-faqs]
  → build-recommender-prompt
  → llm-generate  (provider + model + temp + maxTokens from CACHE KV `llm-config:active`)
```

### Pipeline Steps (`src/pipeline/steps/`)

| Step | Purpose |
|------|---------|
| `safety-gate` | Reject off-topic / harmful queries before pipeline runs |
| `rate-limit` | Per-IP rate gate |
| `analyze-behavior` | Summarize browsing signals into behavior context |
| `intent-classify` | Classify query intent + journey stage |
| `persona-match` | Match user to a persona from the context catalog |
| `use-case-match` | Match query to a product use case |
| `rag-products` | Hybrid keyword + Vectorize product retrieval |
| `rag-features` | Product features for matched products |
| `rag-faqs` | Relevant FAQs |
| `rag-reviews` | Product reviews |
| `rag-content` | Guides, experiences, comparisons, recipes, tools |
| `build-recommender-prompt` | Assemble system + user prompts |
| `llm-generate` | Vendor-agnostic streaming LLM call; emits NDJSON blocks |

### Pipeline Executor / Context

- `pipeline/executor.js` — iterates flow steps, supports sequential and parallel.
- `pipeline/context.js` — `PipelineContext` holds request params, retrieved content, generated output, timings, token counts, `writer` (the NDJSON sink). Headless eval paths must use `createNoopWriter()` — see runner.js gotcha below.

## LLM Providers (`src/providers/`)

| Provider | File | Auth |
|----------|------|------|
| `cerebras` | cerebras.js | `CEREBRAS_API_KEY` secret |
| `cloudflare` | cloudflare.js | `AI` binding (Workers AI) or `CF_ACCOUNT_ID`+`CLOUDFLARE_API_TOKEN` (REST) |
| `sambanova` | sambanova.js | `SAMBANOVA_API_KEY` secret |
| `bedrock` | bedrock.js | `AWS_BEARER_TOKEN_BEDROCK` + `AWS_REGION` |
| `ollama` | ollama.js | `OLLAMA_BASE_URL` var — **local dev only** (`wrangler dev`) |
| `vllm` | vllm.js | `VLLM_BASE_URL` var (OpenAI-compatible) — **local dev only**; also serves local DiffusionGemma via mlx-vlm (`start-diffusion-gemma.sh`) |

`providers/index.js` exposes `MODEL_CATALOG` (the static cloud list — add a row + redeploy to add a model) and `getCatalog(env)`, which resolves local providers live: when `VLLM_BASE_URL`/`OLLAMA_BASE_URL` is set it queries the server (`/v1/models`, `/api/tags`) and replaces the placeholder rows with the real served model ids (falls back to the placeholder if unreachable). The admin picker (`GET /api/admin/catalog`) uses `getCatalog`. Each provider implements an async-iterable contract yielding `{ type: 'delta', text }` chunks and a terminal `{ type: 'usage', usage }` frame. Active provider/model is read from `CACHE` KV (`llm-config:active`) via `src/llm-config.js` — KV wins over per-flow defaults.

## Evaluation Subsystem (`src/evaluations/`)

| File | Role |
|------|------|
| `admin.js` | All `/api/admin/evaluations/*` and `/api/admin/eval-queue/*` HTTP handlers |
| `queue.js` | CF Queue consumer + cron fallback — dispatches `generate`/`judge`/`regenerate`/`rejudge` messages |
| `runner.js` | `runOneQueryHeadless`, `regenerateOneVariantHeadless`, run finalization, judge helpers |
| `judge.js` | Bedrock Anthropic judge — 7-dimension rubric, in-process retry, 429 surfaced for queue-level retry |
| `assertions.js` | Deterministic per-cell assertions (broken-token, unbalanced-html, gold-must-mention, etc.) |
| `suites.js` | Bundled query suites — `coffee-extended`, `coffee-default`, `coffee-dev` |

**Queue config** (`wrangler.jsonc`): `arco-eval-queries` producer + consumer; `max_concurrency: 3`, `max_batch_size: 1`, `max_retries: 5`, DLQ `arco-eval-dlq`. Bedrock 429s use `msg.retry({delaySeconds})` with backoff `30/60/90/120/150s` to cross the 60s quota window.

**Cron fallback** (`triggers.crons: ["*/5 * * * *"]`): `handleEvalCronFallback` scans for runs stuck in `generating`/`judging` with `last_activity_at` older than 2 min and processes up to 5 stuck runs × 3 pending queries / 3 pending judges per tick.

**Headless writer gotcha:** `runOneQueryHeadless`/`regenerateOneVariantHeadless` must use `createNoopWriter()` (a `WritableStream` with a discarding write handler). A `TransformStream` writer without a reader will buffer-block and deadlock the worker.

## Experiment Subsystem (`src/experiments.js`)

Per-query A/B runner. `handleCreateExperiment` fans out 1–12 `{provider, model, temperature, maxTokens}` variants in parallel, **sharing** the upstream pipeline (`shared_duration_ms`) — only `llm-generate` re-runs per variant. RAG context persists to KV (`experiment:{expId}:rag-context`) so judge re-runs and per-cell regenerates don't re-pay retrieval cost.

## Feedback Subsystem (`src/feedback.js`)

| Handler | Route |
|---------|-------|
| `handleSubmitFeedback` | `POST /api/feedback` (public, no auth, 204 on success) |
| `handleListFeedback` | `GET /api/admin/feedback` (filters: rating/flag/model/q/hasComment/since/until) |
| `handleRunFeedback` | `GET /api/admin/feedback/run/:runId` |
| `handleFeedbackSummary` | `GET /api/admin/feedback/summary` |
| `handleFeedbackExport` | `GET /api/admin/feedback/export?format=csv\|json` |
| `attachFeedbackToQueries(env, queries)` | Helper used by `?include=feedback` on `/api/admin/evaluations/:id` |

Upserts use `UNIQUE(run_id, session_id)`. Comment is truncated server-side to 1000 chars; flag keys + product slugs validated against allow-lists.

## Key Source Files

| File | Purpose |
|------|---------|
| `src/index.js` | Router + `fetch`/`queue`/`scheduled` exports |
| `src/admin.js` | Sessions/Pages/Runs/Catalog/LLM-config handlers, server-rendered admin SPA |
| `src/experiments.js` | `/api/admin/experiments` create/list/get handlers + variant viewer |
| `src/feedback.js` | All feedback HTTP handlers + eval-matrix attach helper |
| `src/evaluations/*` | Eval orchestration (queue, judge, runner, assertions, suites) |
| `src/providers/*` | LLM provider adapters + `MODEL_CATALOG` |
| `src/llm-config.js` | `getActiveLlmConfig(env)` — read/write `llm-config:active` in CACHE KV |
| `src/storage.js` | `saveGeneration()` — writes D1 metadata + KV payload |
| `src/context.js` | Content retrieval — hybrid keyword + Vectorize semantic search |
| `src/recommender-prompt.js` | System/user prompt templates |
| `src/block-guide.js` | EDS block authoring guide injected into LLM prompt |
| `src/brand-voice.js` | Brand voice guidelines injected into prompts |
| `src/da-persist.js` | DA OAuth + create page + trigger preview + publish-to-live |
| `src/images.js` | Image selection + `{{story:slug}}` / `{{experience:slug}}` / `{{product:slug}}` resolution |
| `src/hero-images.js` | Hero image selection logic |
| `src/json-to-eds.js` | LLM JSON → EDS HTML block markup |
| `src/analytics.js` | Analytics event processing and aggregation |
| `src/stream-parser.js` | Splits LLM output on `===` into JSON blocks; tolerates ```` ```json ```` fences + stray prose |
| `src/sanitize.js` | Input sanitization |

## Cloudflare Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `SESSIONS_DB` | D1 | Session/run/experiment/eval/feedback metadata (`arco-sessions`) |
| `SESSION_STORE` | KV | Run payloads (`page:{runId}`), experiment variant payloads (`experiment:{expId}:variant:{vid}`, `experiment:{expId}:rag-context`) |
| `CACHE` | KV | HTTP cache + `llm-config:active` |
| `GUIDES` | KV | Static guide content for RAG |
| `ANALYTICS` | Analytics Engine | `arco_usage` dataset |
| `AI` | Workers AI | Query embeddings (`@cf/baai/bge-base-en-v1.5`) + Cloudflare LLM provider |
| `CONTENT_INDEX` | Vectorize | `arco-content` semantic search index |
| `EVAL_QUEUE` | Queue producer | `arco-eval-queries` |
| (consumer) | Queue consumer | `arco-eval-queries`, max_concurrency 3, DLQ `arco-eval-dlq` |

Triggers: `crons: ["*/5 * * * *"]` (eval cron fallback).

## DA Persistence Flow

```
saveGeneration(ctx, env, sessionId)
  → D1: upsertSession() + nextRunIndex() + insertRun()
  → KV SESSION_STORE: store debug snapshot + blocks at page:{runId}

persistAndPublish(path, html, env)      [da-persist.js]
  → DA OAuth: exchange client credentials for access token
  → DA API: createPage()
  → DA API: triggerPreview()
  → waitForPreview() (polls up to 10× with 1s interval)
  → DA API: publishToLive()
  → CDN: purgeCache()
```

## Content Retrieval (`src/context.js`)

Hybrid retrieval:
1. Keyword matching against hardcoded product/feature/FAQ/recipe/story/experience catalogs.
2. Vectorize semantic search (`CONTENT_INDEX`) for broader content matches via `searchContent()`.
3. Results merged + deduped; unpublished story/experience slugs are filtered (see `published` field gate in `scripts/index-content.js` and `src/images.js`).

Exports: `searchContent()`, `getRelevantProducts()`, `getRelevantFeatures()`, `getRelevantFaqs()`, `matchPersona()`, `matchUseCase()`.
