<!-- Generated: 2026-06-12 | Files scanned: 6 | Token estimate: ~600 -->

# Dependencies & Integrations

## External Services

| Service | Purpose | Config |
|---------|---------|--------|
| AEM Edge Delivery Services (`*.aem.live`) | Content backend, preview/publish, CDN | `fstab.yaml` |
| Cloudflare Workers | Recommender API runtime (`arco-recommender`) | `workers/recommender/wrangler.jsonc` |
| Cloudflare D1 | Session, run, experiment, eval, feedback metadata | binding `SESSIONS_DB` (`arco-sessions`) |
| Cloudflare KV | Run payloads, cache, guides, analytics | bindings `SESSION_STORE`, `CACHE`, `GUIDES` |
| Cloudflare Vectorize | Semantic RAG search index | binding `CONTENT_INDEX` (`arco-content`) |
| Cloudflare Workers AI | Text embeddings + `cloudflare` LLM provider | binding `AI` |
| Cloudflare Queues | Async eval orchestration | producer `EVAL_QUEUE` → `arco-eval-queries` |
| Cloudflare Analytics Engine | Usage analytics | binding `ANALYTICS` (`arco_usage`) |
| Cloudflare Cron Triggers | Eval stuck-run fallback | `*/5 * * * *` |
| Cerebras | LLM provider (e.g. `gpt-oss-120b`) | `CEREBRAS_API_KEY` secret |
| SambaNova | LLM provider (OpenAI-compatible REST, e.g. `DeepSeek-V3.2`) | `SAMBANOVA_API_KEY` secret |
| AWS Bedrock | LLM provider (Claude / others) + LLM-judge | `AWS_BEARER_TOKEN_BEDROCK` + `AWS_REGION` |
| Ollama / vLLM / mlx-vlm | Local LLM provider (incl. DiffusionGemma via `start-diffusion-gemma.sh`) — **dev only** | `OLLAMA_BASE_URL` / `VLLM_BASE_URL` var |
| DA (Document Authoring) | Generated page storage + preview/publish | `DA_CLIENT_ID` + `DA_CLIENT_SECRET` (or `DA_SERVICE_TOKEN` / legacy `DA_TOKEN`) |

## Worker Secrets (`wrangler secret put`)

| Secret | Used by |
|--------|---------|
| `CEREBRAS_API_KEY` | Cerebras LLM inference |
| `SAMBANOVA_API_KEY` | SambaNova LLM inference |
| `AWS_BEARER_TOKEN_BEDROCK` | AWS Bedrock LLM + judge |
| `DA_CLIENT_ID` | DA OAuth client credentials |
| `DA_CLIENT_SECRET` | DA OAuth client credentials |
| `DA_SERVICE_TOKEN` | DA S2S token (preferred over OAuth in some setups) |
| `DA_TOKEN` | Legacy DA fallback token |
| `ADMIN_TOKEN` | HTTP Basic auth password for `/admin` + `/api/admin/*` |
| `CF_API_TOKEN` | Cloudflare Queues + Analytics Engine read for eval queue ops |

Plain vars (not secrets): `AWS_REGION` (default `us-east-1`), `ENVIRONMENT`, `DA_ORG`, `DA_REPO`.

## Frontend Dependencies

No runtime JS dependencies — vanilla ES6+. Dev tooling only:

| Package | Purpose |
|---------|---------|
| `@adobe/aem-cli` (global) | Local dev server (`aem up`) |
| `eslint` + `eslint-config-airbnb-base` | Airbnb-style linting |
| `stylelint` + `stylelint-config-standard` | CSS linting |
| `playwright` | UI verification (dev only) |

See `package.json` for exact versions.

## Worker Dependencies (`workers/recommender/package.json`)

```
@cerebras/cerebras_cloud_sdk   Cerebras LLM SDK
wrangler                       Cloudflare Workers CLI (dev)
```

All other provider integrations (Cloudflare AI, SambaNova, Bedrock) use the platform binding or direct `fetch()` to the vendor REST API — no SDK dependency.

## Key Integration Points

### EDS → Worker

`scripts/scripts.js` POSTs to `ARCO_RECOMMENDER_URL` (from `api-config.js`) with:

```json
{
  "query": "...",
  "sessionId": "...",
  "pageId": "...",
  "runId": "...",
  "pageUrl": "...",
  "parentRunId": "...",
  "context": { "queries": [...], "browsingHistory": [...], "inferredProfile": {...} }
}
```

Response: NDJSON SSE stream (`section` / `follow-up` / `debug` / `cache-hit` / `error` events).

`scripts/api-config.js` routes `localhost`/`127.0.0.1` to the local `wrangler dev` worker (port 8789), `*.aem.page` hostnames to a branch worker version (`{alias}-arco-recommender.franklin-prod.workers.dev`), and `*.aem.live` / `arco.coffee` to production. `ARCO_CONFIG.RECOMMENDER_URL` or `localStorage['arco-recommender-url']` override all of the above.

### Worker → DA

`src/da-persist.js` uses DA REST API with OAuth2 service-to-service tokens:

```
POST /api/token                                exchange credentials → access token
PUT  /source/{org}/{repo}/{path}               create/update page HTML
POST /preview/{org}/{repo}/{path}              trigger preview
POST /live/{org}/{repo}/{path}                 publish to live
```

### Worker → Vectorize

`searchContent()` in `src/context.js`:
1. Generate query embedding via `env.AI.run('@cf/baai/bge-base-en-v1.5', { text: query })`.
2. `env.CONTENT_INDEX.query(embedding, { topK: N })`.

### Worker → Cloudflare Queues (Eval orchestration)

`POST /api/admin/evaluations/start` publishes one `{type:'generate', evalRunId, queryId}` per query to `EVAL_QUEUE`. The consumer (`queue()` export in `src/index.js` → `handleEvalQueue` in `src/evaluations/queue.js`) dispatches by `type`, completes the run, and uses `msg.retry({delaySeconds})` for Bedrock 429s. Diagnostic endpoints (`/api/admin/eval-queue/*`) call the CF Queues REST API using `CF_API_TOKEN`.

### Worker → AWS Bedrock

Both the recommender LLM step (when the active provider is `bedrock`) and the LLM-judge (`src/evaluations/judge.js`) call AWS Bedrock via the bearer-token API. Cross-region inference profile IDs are baked into `MODEL_CATALOG`. 429s retry once in-process (~500 ms) then surface to the queue layer for a longer `delaySeconds` retry.

### Client-Side Signal → Context → Request

```
browsing-signals.js → SessionContextManager → scripts.js /api/generate body
```

### Client → Feedback

```
feedback-widget.js → POST /api/feedback {runId, sessionId, pageId, rating, comment, flags[], wrongProducts[], dwellMs}
```

No auth required. Server-side dedup via `UNIQUE(run_id, session_id)`.
