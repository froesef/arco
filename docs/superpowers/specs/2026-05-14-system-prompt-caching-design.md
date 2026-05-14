# System Prompt Caching for Bedrock

## Problem

The recommender worker rebuilds the entire system prompt on every request, mixing static reference material (product catalog, rules, templates) with dynamic per-request context (RAG results, behavior analysis, session history). When using Amazon Bedrock as the LLM provider, this means the full prompt is re-processed every time — no prefix caching benefit, higher cost, higher latency.

## Decision

Restructure prompt assembly so the system message is 100% static and the user message carries all per-request context. Enable Bedrock's prompt caching automatically.

## Design

### System Prompt (Static, Cached)

The system prompt contains only content that is identical across all requests:

1. **Brand voice guidelines** — tone, personality, writing rules
2. **Approach/flow instructions** — how to structure responses
3. **Critical rules** — hard constraints (no hallucinated products, no prices outside catalog, etc.)
4. **Block syntax & guidance** — EDS block formatting rules
5. **ALL page structure templates** — all ~12 intent-specific templates included together; the LLM selects the appropriate one based on intent passed in the user message
6. **Full product catalog** — never filtered by price tier; all products always present
7. **Accessories catalog** — full accessory list

### User Message (Dynamic, Per-Request)

Everything that varies per query:

1. **Query** — the user's natural language input
2. **Intent classification** — detected intent type (espresso, comparison, budget, etc.) so the LLM knows which page structure template to follow
3. **Behavior analysis** — price tier, skill level, use-case priorities, purchase readiness stage
4. **Matched persona + use-case** — persona name, priorities, and use-case description
5. **RAG context** — recommended products, guides/articles, experiences, reviews, FAQs, comparisons, features, hero images
6. **Session context** — previous queries, already-shown products with hardware facts
7. **Follow-up context** — pivot type, label, parent run info
8. **Feature detection results** — hardware features requested and matching machines

### Provider Changes

**All providers (Cerebras, Cloudflare, SambaNova, Bedrock):**
- Single restructured prompt assembly code path
- `buildRecommenderSystemPrompt()` becomes static (no parameters except the product/accessory data which is imported at module load time)
- `buildRecommenderUserMessage()` accepts all dynamic context and assembles the complete user message

**Bedrock provider only:**
- Automatically inserts a `cachePoint` marker after the system message in every Converse API request
- No configuration toggle — Bedrock silently ignores the marker if the minimum token threshold (~2,048) isn't met
- No fallback logic needed

### Files to Modify

| File | Change |
|------|--------|
| `workers/recommender/src/recommender-prompt.js` | Refactor `buildRecommenderSystemPrompt()` to be static (include all templates, full catalog). Move RAG, behavior, persona, session, feature detection into `buildRecommenderUserMessage()`. |
| `workers/recommender/src/pipeline/steps/build-recommender-prompt.js` | Update to pass dynamic context to user message builder instead of system prompt builder. |
| `workers/recommender/src/providers/bedrock.js` | Add `cachePoint` in the system message array for the Converse API. |

### No Changes Needed

- Other providers (`cerebras.js`, `cloudflare.js`, `sambanova.js`) — they pass messages as-is; the restructured content flows through without code changes.
- Pipeline steps (intent-classify, analyze-behavior, rag-*, persona-match, etc.) — they still produce the same outputs; only where those outputs are placed in the prompt changes.
- Evaluation and experiment infrastructure — uses the same pipeline; benefits automatically.

## Expected Benefits

- **Cost reduction**: Bedrock charges 90% less for cached input tokens. The static system prompt (~8-12k tokens) is cached on every request.
- **Latency reduction**: Cached prefix tokens are processed faster, reducing TTFT.
- **Code clarity**: Clean separation — system = reference material, user = this specific request's context.
- **Cache hit rate**: Near 100% since the system prompt never changes (no price filtering, no per-intent template selection).

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| LLM quality regression from moving RAG/context to user message | Run eval suite before/after to compare quality scores. LLMs handle context in user messages equivalently for grounding. |
| Including ALL templates makes system prompt longer | Extra ~1-2k tokens, trivial compared to the catalog. Cached tokens cost 90% less anyway. |
| Full catalog without price filter produces irrelevant recommendations | Price tier is communicated in user message; LLM self-selects. Verify with eval that budget queries don't surface premium products. |

## Validation

1. Run `coffee-dev` eval suite (3 queries) with Bedrock provider before and after
2. Confirm TTFT improvement on cached requests
3. Run `coffee-extended` suite to verify quality scores don't regress
4. Check Bedrock CloudWatch metrics for cache hit rate
