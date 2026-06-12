<!-- Generated: 2026-06-12 | Files scanned: 30+ | Token estimate: ~900 -->

# Frontend Architecture

## Entry Points

```
head.html → scripts/aem.js              (core EDS decoration, DO NOT MODIFY)
          → scripts/scripts.js          (main decoration + recommender rendering)
          → styles/styles.css           (critical / LCP styles)
          → styles/lazy-styles.css      (post-LCP styles)
          → scripts/delayed.js          (3s after load — starts browsing signals)
```

## Three-Phase Loading

| Phase | Trigger | Key work |
|-------|---------|---------|
| Eager | immediately | decorate sections/blocks, load first section, LCP |
| Lazy | after LCP | load header/footer, remaining blocks |
| Delayed | 3s after load | `collectBrowsingSignals()`, analytics, prefetch |

## Key Scripts

| File | Purpose |
|------|---------|
| `scripts/scripts.js` | Page decoration, auto-blocks, recommender SSE streaming, deterministic cache slug, feedback widget attachment |
| `scripts/aem.js` | Core EDS library (block loading, section decoration). Read-only — never edit. |
| `scripts/session-context.js` | `SessionContextManager` — sessionStorage for queries + browsing history + inferred profile |
| `scripts/browsing-signals.js` | Passive signal collector + local rule-based intent classifier |
| `scripts/recommender-stream.js` | NDJSON SSE parser; renders sections progressively; stamps `data-run-id` per section |
| `scripts/feedback-widget.js` | Run-level feedback widget (👍 / 👎, comment, flag categories, wrong-product chips) |
| `scripts/speculative-engine.js` | Mouse-deceleration heuristic for prefetching follow-up chips |
| `scripts/for-you-prefetch.js` | Background prefetch for personalized "For You" query |
| `scripts/api-config.js` | `ARCO_RECOMMENDER_URL` — routes `localhost`→local `wrangler dev` worker (8789), `*.aem.page`→branch worker version, else prod. Overridable via `ARCO_CONFIG.RECOMMENDER_URL` or `localStorage['arco-recommender-url']` |
| `scripts/delayed.js` | Kicks off `collectBrowsingSignals()` |
| `scripts/block-aliases.js` | Block-name aliases for author-friendly variants |
| `scripts/section-metadata.js` | Section metadata parsing helpers |
| `scripts/welcome-modal.js` | One-time welcome modal |
| `scripts/placeholders.js` | Fetches `/query-index.json` placeholder values |

## Recommender Page Rendering (`scripts/scripts.js`)

```
renderArcoRecommenderPage(query)
  │
  ├─ Check sessionStorage for quiz prefetch     → renderPrefetchedBlocks()
  ├─ Check sessionStorage for ForYou prefetch
  │     ├─ NDJSON lines cached → replaySpeculativeResult()
  │     └─ Block data cached   → renderPrefetchedBlocks()
  └─ No prefetch → SSE stream to /api/generate
        │  NDJSON events: section | follow-up | debug | cache-hit | error
        ├─ cache-hit → redirect to liveUrl
        └─ render sections inline (recommender-stream.js)
              → stamp `section.dataset.runId`
              → attach feedback widget before .follow-up-container
              → attach speculative-engine to follow-up chips
```

## Auto-Blocks (`buildAutoBlocks`)

| Block | Trigger |
|-------|---------|
| `hero` | First `<h1>` + `<picture>` in main |
| `fragment` | Links matching `/fragments/` path |
| `personalization-banner` | Built from session context on recommender pages |

## Blocks (35 total)

```
accordion/        article-excerpt/   blog-card/         bundle-card/
calculator/       cards/             carousel/          columns/
comparison-table/ debug-panel/       embed/             experience-cta/
follow-up/        footer/            form/              fragment/
header/           hero/              keep-exploring/    modal/
personalization-banner/  product-card/  product-detail/  product-list/
quiz/             quote/             recipe-steps/      search/
stats/            table/             tabs/              testimonials/
video/            admin/             analytics-analysis/
```

### Notable Blocks

| Block | Purpose |
|-------|---------|
| `admin` | EDS-hosted admin SPA — sessions, experiments, evaluations, model settings, vectorize, feedback (see `docs/ADMIN.md`) |
| `follow-up` | Renders follow-up chip suggestions from recommender |
| `keep-exploring` | Renders the always-on "keep exploring" chip row driven by `/api/suggest` |
| `modal` | `attachModalTrigger(anchor)` — opens story/experience fragments as modal instead of navigating |
| `debug-panel` | Shows RAG/prompt/timing debug data (admin/debug mode) |
| `quiz` | Interactive quiz that fires a prefetched recommender query |
| `product-card / -list / -detail` | Product display with dynamic personalization |
| `analytics-analysis` | Embeds analytics-derived insights into authored content |

## Admin Block (`blocks/admin/admin.js` + `admin.css`)

Self-contained hash-routed SPA. Login UI prompts for the `ADMIN_TOKEN` once; auth header is stored in localStorage (`arco-admin-auth`) and cleared via the Reset Token button. See `docs/ADMIN.md` for full route + view documentation. Hash routes:

```
#/                                       Sessions list (default)
#/sessions/:id                           Session detail + pages
#/pages/:id[/:tab]                       Page detail — overview / reconstruction / timeline / debug / feedback
#/llm-config                             Model settings (active provider/model/temp/maxTokens)
#/experiments                            Experiments list
#/experiments/new                        New experiment form + live run
#/experiments/:id                        Experiment detail (variant flip-through)
#/experiments/:id/variants/:variantId    Deep link to a variant
#/evaluations                            LLM Evaluation runs
#/evaluations/new                        New evaluation form
#/evaluations/:id                        Evaluation matrix (queries × models)
#/vectorize                              Vectorize index stats
#/vectorize/search                       k-NN similarity search
#/vectorize/items/:id                    Vector item detail
#/feedback                               Feedback list + summary + export
#/feedback/run/:runId                    Per-run feedback detail
#/insights                               Reserved (LLM-summarized feedback — stub)
```

## Feedback Widget

`scripts/feedback-widget.js` (lazy-imported by `recommender-stream.js` after streaming completes).

- Inserts above `.follow-up-container` on fresh `/?q=` runs only — cached `/discover/{slug}` views are out of scope.
- 👍 fires single `POST /api/feedback {rating:+1}` then collapses to "Thanks 👍" with optional `Add a note` chip.
- 👎 fires `POST /api/feedback {rating:-1}` immediately (captures even if user bails), then expands: comment textarea (≤1000 chars), four flag checkboxes, and a product multi-select populated from `[data-run-id="…"] a[href*="/products/"]`.
- `localStorage[arco-feedback:{runId}]` suppresses re-prompts on refresh; server-side `UNIQUE(run_id, session_id)` is the truth.

## Session Context Flow

```
browsing-signals.js   →   SessionContextManager (sessionStorage)
  • page signals             • queries[]
  • scroll depth             • browsingHistory[] (last 15)
  • interactions             • inferredProfile{ intent, stage, productsViewed[] }
  • quiz answers

scripts.js  →  reads SessionContextManager  →  encodes ctx  →
  POST /api/generate { query, sessionId, pageId, runId, pageUrl, parentRunId?, context }
```

## Speculative Prefetch

`speculative-engine.js` watches mouse deceleration toward follow-up chips. When confidence threshold is reached → fires a `speculative: true` prefetch request to `/api/generate`. Result cached in sessionStorage so `replaySpeculativeResult()` plays back NDJSON instantly on click.

## CSS Structure

```
styles/styles.css           — critical LCP styles, layout skeleton
styles/lazy-styles.css      — post-LCP styles
styles/fonts.css            — web font definitions
styles/feedback-widget.css  — feedback widget (scoped, only loaded with the widget)
blocks/{name}/{name}.css    — block-scoped styles (on-demand)
```

Responsive breakpoints: 600 px (tablet), 900 px (desktop), 1200 px (wide). Mobile-first with `min-width` queries.
