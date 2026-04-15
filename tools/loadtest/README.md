# Load Testing Workbench

Tools for stress-testing the Arco generative recommender — both the full end-to-end browser experience and the worker API directly.

## Prerequisites

```bash
npm install
npx playwright install chromium   # only needed for browser mode
```

## Modes

Two test modes are available, each measuring a different slice of the stack:

| Mode | What it tests | Typical throughput |
|------|---------------|--------------------|
| `--mode browser` (default) | Full end-user experience: page load, JS execution, API, DOM rendering | ~10–15 pages/s (single machine) |
| `--mode http` | Worker API directly via `fetch()`, no browser | 500+ pages/s |

Use **browser mode** to measure real user experience and catch regressions in page rendering. Use **HTTP mode** to stress-test the worker, Cerebras, and RAG pipeline without browser overhead as the limiting factor.

## Quick Start

```bash
# Smoke test — 10 requests, browser visible
node tools/loadtest/loadtest.js --total 10 --parallel 2 --no-headless

# Browser stress test — 200 requests, 10 parallel (sweet spot for a single machine)
node tools/loadtest/loadtest.js --total 200 --parallel 10 --rate 20

# HTTP stress test — 500 requests hitting the worker directly
node tools/loadtest/loadtest.js --mode http --total 500 --parallel 50 --rate 200

# Isolate Cerebras — full pipeline via HTTP, no browser noise
node tools/loadtest/loadtest.js --mode http --total 200 --parallel 20 --rate 100

# Dry run — print config and sample prompts, no requests sent
node tools/loadtest/loadtest.js --dry-run
```

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--mode browser\|http` | `browser` | Test mode (see above) |
| `--total N` | 1000 | Total requests to send |
| `--rate N` | 0.5 | Max requests per second |
| `--parallel N` | 3 | Concurrent contexts / HTTP slots |
| `--base-url URL` | `https://main--arco--froesef.aem.live` | Target site (browser mode) |
| `--worker-url URL` | `https://arco-recommender.franklin-prod.workers.dev` | Worker endpoint (HTTP mode) |
| `--timeout N` | 120000 | Per-request timeout in ms |
| `--loadtest-token TOKEN` | `$LOADTEST_TOKEN` | Bypass worker rate limit (see below) |
| `--skip-cerebras` | off | Skip Cerebras LLM, stream dummy content (RAG still runs) |
| `--skip-pipeline` | off | Skip entire pipeline, stream dummy content immediately |
| `--no-screenshots` | - | Disable screenshot capture (browser mode) |
| `--regen` | - | Force page regeneration, skip DA cache |
| `--no-headless` | - | Show browser windows |
| `--dry-run` | - | Print config and sample prompts, then exit |
| `--output DIR` | `tools/loadtest/results` | Output directory |
| `--prompts FILE` | `tools/loadtest/prompts.json` | Prompt list |
| `--viewport WxH` | `1280x800` | Browser viewport |

Options can also be set via environment variables. Put them in a `.env` file at the project root:

```
LOADTEST_TOKEN=your-token-here
```

## Rate Limiting

The worker enforces **30 requests per 60 seconds per IP** by default.

- **Default rate (0.5/s):** Safe under the limit. 1000 requests ≈ 33 minutes.
- **With `--loadtest-token`:** The worker skips rate limiting. You can use any `--rate` value safely. Get the token from the worker's secret configuration or set it in `.env`.
- **Without a token at rate > 0.5/s:** The client uses a burst-then-wait strategy (28 fast, wait 60s, repeat) to stay under the limit.
- **429 auto-backoff:** If the server returns 429, the client pauses 60 seconds automatically.

## Bottleneck Isolation

Run these in sequence to identify where time is being spent:

```bash
# 1. Baseline: pure network + worker overhead (no pipeline, no browser)
node tools/loadtest/loadtest.js --mode http --total 200 --parallel 50 --rate 2000 --skip-pipeline

# 2. Add RAG: Vectorize + AI embedding (still no LLM, no browser)
node tools/loadtest/loadtest.js --mode http --total 200 --parallel 20 --rate 100 --skip-cerebras

# 3. Full pipeline: everything including Cerebras LLM
node tools/loadtest/loadtest.js --mode http --total 200 --parallel 20 --rate 50

# 4. Browser overhead: compare against step 3
node tools/loadtest/loadtest.js --mode browser --total 200 --parallel 10 --rate 20
```

Comparing throughput across steps shows where the bottleneck is:
- Step 1 → 2 slow: Vectorize/embedding is the bottleneck
- Step 2 → 3 slow: Cerebras is the bottleneck
- Step 3 → 4 slow: Playwright/browser overhead is the bottleneck

## Parallelism Guidelines

**Browser mode** is CPU-bound on a single machine. Chrome processes compete for CPU and network connections.

- **10–15 parallel:** Sweet spot. Fast page load, API response times are representative.
- **>20 parallel:** Diminishing returns. Page load times inflate, API response times are distorted by client-side pressure.

**HTTP mode** scales much further. Node.js handles many concurrent `fetch()` calls efficiently.

- **50–100 parallel:** Good for measuring worker throughput and Cerebras capacity.
- **Rate:** Set high (`--rate 2000`) to let the semaphore be the only governor. The worker will push back with 429s if overloaded.

## Output

Each run creates a timestamped directory:

```
tools/loadtest/results/run-2026-04-14T10-30-00/
  results.json     # Full timing data + aggregate stats
  summary.txt      # Human-readable summary
  errors.json      # Failed requests with full error details
  screenshots/     # JPEG screenshots (browser mode only)
```

### Summary Format

```
=== Load Test Summary ===

Duration:     12s (browser init: 3s)
Total:        200
Success:      186 (93.0%)
Errors:       14
Throughput:   930.0 pages/min  (15.5 pages/s)

Timing (total page load):
  Min:    0.3s  Mean:  0.8s  Median: 0.7s  P95: 1.4s  Max: 2.1s

Time to first section:
  Min:    0.1s  Mean:  0.4s  Median: 0.4s  P95: 0.8s

Timing phases (mean → p95):
  Page load   (nav → DOMContentLoaded):  0.24s → 0.41s
  API response (DOM → 1st section):       0.13s → 0.32s
  Streaming   (1st section → done):       0.17s → 0.30s
```

**Timing phases** show where time is spent within each request. Under load, watch which phase degrades first.

### Progress Lines

```
[+1.1s] [47/200] SUCCESS  0.3s  "best espresso machine for beginners" (4 sections)
[+1.2s] [48/200] ERROR    0.9s  "Primo vs Doppio comparison" (0 sections) [cerebras/429]
```

- `[+Xs]` — elapsed time since test start (excludes browser init)
- Duration — time for that individual request
- Error codes: `[source/code]` e.g. `[cerebras/429]`, `[worker/503]`, `[client/timeout]`

## Prompts

`prompts.json` contains 1000 pre-generated queries across 9 categories (product-specific, comparison, buying-guide, use-case, recipe-drink, technique, troubleshooting, exploration, persona-driven). A random subset is selected for each run.

To regenerate from content data:

```bash
npm run loadtest:generate-prompts
```

## Notes

- Screenshots at JPEG quality 80 are ~300–500KB each. A 1000-query run uses ~300–500MB. Use `--no-screenshots` to skip.
- The Cerebras SDK retries 429 and 5xx responses up to 2 times with backoff before surfacing an error. Under high load, slow-but-successful requests may have been retried internally.
- Results are written on Ctrl+C (graceful shutdown), so you can stop a long run early and still get a partial summary.
