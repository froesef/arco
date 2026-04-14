# Load Testing Workbench

Browser-based load testing for the Arco generative recommender. Uses Playwright to send real browser requests to `/?q=...` and captures screenshots, timing, and error data.

## Prerequisites

```bash
npm install
npx playwright install chromium
```

## Quick Start

```bash
# Quick smoke test (10 queries, visible browser)
npm run loadtest:quick -- --no-headless

# Full run (1000 queries, ~33 minutes)
npm run loadtest

# Dry run (preview config without sending requests)
node tools/loadtest/loadtest.js --dry-run
```

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--total N` | 1000 | Total number of requests |
| `--rate N` | 0.5 | Max requests per second |
| `--parallel N` | 3 | Concurrent browser contexts |
| `--base-url URL` | `https://main--arco--froesef.aem.live` | Target site |
| `--timeout N` | 120000 | Per-page timeout (ms) |
| `--no-screenshots` | - | Disable screenshot capture |
| `--regen` | - | Force page regeneration (skip cache) |
| `--no-headless` | - | Show browser windows |
| `--dry-run` | - | Print config and exit |
| `--output DIR` | `tools/loadtest/results` | Output directory |
| `--prompts FILE` | `tools/loadtest/prompts.json` | Prompt file |
| `--viewport WxH` | `1280x800` | Browser viewport size |

## Rate Limiting

The backend limits requests to **30 per 60 seconds per IP**. The workbench respects this automatically:

- **Default (0.5 req/s)**: Steady drip, safe under the limit. 1000 queries takes ~33 minutes.
- **Burst mode (rate > 1)**: Sends 28 requests fast, waits 60s for the rate limit window to expire, repeats. Same total time but better parallelism per burst.
- **429 auto-backoff**: If the server returns 429, the workbench pauses for 60 seconds automatically.

For higher throughput testing, you can modify the worker's rate limit at `workers/recommender/src/pipeline/steps/rate-limit.js` (change `DEFAULT_MAX` or add an admin token bypass).

## Output

Each run creates a timestamped directory:

```
tools/loadtest/results/run-2026-04-14T10-30-00/
  screenshots/     # JPEG screenshot per completed page
  results.json     # Full timing data + aggregate stats
  summary.txt      # Human-readable summary
  errors.json      # Failed requests with error details
```

### Metrics Captured

- **Time to first section (TTFS)**: When the first content section renders
- **Time to interactive (TTI)**: When follow-up suggestions appear (stream complete)
- **Server-reported time**: Extracted from console `[Recommender] Complete in Xs`
- **Section count**: Number of content sections generated
- **Per-category breakdown**: Aggregate stats by prompt type

## Prompts

The `prompts.json` file contains 1000 pre-generated queries across 9 categories:

| Category | Count | Examples |
|----------|-------|---------|
| product-specific | 150 | "Tell me about the Arco Studio Pro" |
| buying-guide | 130 | "best espresso machine under 1000" |
| use-case | 130 | "espresso machine for a small kitchen" |
| comparison | 120 | "Primo vs Doppio for a beginner" |
| recipe-drink | 100 | "how to make a flat white at home" |
| technique | 100 | "how to dial in espresso" |
| exploration | 100 | "what do you recommend for someone new?" |
| persona-driven | 90 | "I just moved into my first apartment" |
| troubleshooting | 80 | "my espresso tastes sour" |

To regenerate prompts from content data:

```bash
npm run loadtest:generate-prompts
```

## Disk Space

Screenshots at JPEG quality 80 are ~300-500KB each. A full 1000-query run uses ~300-500MB. Use `--no-screenshots` to skip.

## Troubleshooting

**"Cannot find playwright"**: Run `npx playwright install chromium` to download the browser binary.

**High memory usage**: Reduce `--parallel` or increase `--rate` (fewer concurrent contexts). Each context uses ~50-100MB.

**Many timeouts**: The default 120s timeout is generous but some LLM generations take longer. Check `errors.json` for patterns. Increase with `--timeout 180000`.

**All requests return 429**: You're hitting the rate limit. Use `--rate 0.5` (the default) or temporarily increase the worker's rate limit.
