/**
 * CLI configuration parser for the load testing workbench.
 * Parses process.argv and .env file — no external dependencies.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env from project root (two levels up from tools/loadtest/)
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../../.env');
try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* .env not found — that's fine */ }

const DEFAULTS = {
  total: 1000,
  rate: 0.5,
  parallel: 3,
  baseUrl: 'https://main--arco--froesef.aem.live',
  timeout: 120_000,
  screenshots: true,
  regen: false,
  headless: true,
  dryRun: false,
  output: 'tools/loadtest/results',
  prompts: 'tools/loadtest/prompts.json',
  viewport: '1280x800',
  skipCerebras: false,
  skipPipeline: false,
  mode: 'browser',
  workerUrl: 'https://arco-recommender.franklin-prod.workers.dev',
};

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;

    const key = arg.slice(2);
    // Boolean flags that don't take a value
    const booleanFlags = ['screenshots', 'regen', 'headless', 'dry-run', 'no-screenshots', 'no-headless', 'skip-cerebras', 'skip-pipeline'];
    if (booleanFlags.includes(key)) {
      if (key.startsWith('no-')) {
        args[key.slice(3)] = false;
      } else {
        args[key] = true;
      }
      continue;
    }
    // Key-value flags
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function camelCase(str) {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function parseConfig(argv = process.argv) {
  const raw = parseArgs(argv);
  const get = (flag, fallback) => {
    const cc = camelCase(flag);
    if (cc in raw) return raw[cc];
    if (flag in raw) return raw[flag];
    return fallback;
  };

  const config = {
    total: parseInt(get('total', DEFAULTS.total), 10),
    rate: parseFloat(get('rate', DEFAULTS.rate)),
    parallel: parseInt(get('parallel', DEFAULTS.parallel), 10),
    baseUrl: get('base-url', DEFAULTS.baseUrl).replace(/\/$/, ''),
    timeout: parseInt(get('timeout', DEFAULTS.timeout), 10),
    screenshots: get('screenshots', DEFAULTS.screenshots),
    regen: get('regen', DEFAULTS.regen),
    headless: get('headless', DEFAULTS.headless),
    dryRun: get('dry-run', DEFAULTS.dryRun),
    output: get('output', DEFAULTS.output),
    prompts: get('prompts', DEFAULTS.prompts),
    viewport: get('viewport', DEFAULTS.viewport),
    loadtestToken: get('loadtest-token', process.env.LOADTEST_TOKEN || ''),
    skipCerebras: get('skip-cerebras', DEFAULTS.skipCerebras),
    skipPipeline: get('skip-pipeline', DEFAULTS.skipPipeline),
    mode: get('mode', DEFAULTS.mode),
    workerUrl: get('worker-url', DEFAULTS.workerUrl).replace(/\/$/, ''),
  };

  // Ensure boolean types
  if (typeof config.screenshots === 'string') config.screenshots = config.screenshots !== 'false';
  if (typeof config.headless === 'string') config.headless = config.headless !== 'false';

  // Parse viewport
  const [w, h] = config.viewport.split('x').map(Number);
  config.viewportWidth = w || 1280;
  config.viewportHeight = h || 800;

  return Object.freeze(config);
}

export function printConfig(config) {
  console.log('\n=== Load Test Configuration ===');
  console.log(`  Target:       ${config.baseUrl}`);
  console.log(`  Total:        ${config.total} requests`);
  console.log(`  Rate:         ${config.rate} req/s`);
  console.log(`  Parallel:     ${config.parallel} browser contexts`);
  console.log(`  Timeout:      ${config.timeout}ms per page`);
  console.log(`  Screenshots:  ${config.screenshots}`);
  console.log(`  Regen:        ${config.regen}`);
  console.log(`  Headless:     ${config.headless}`);
  console.log(`  Output:       ${config.output}`);
  console.log(`  Viewport:     ${config.viewportWidth}x${config.viewportHeight}`);
  if (config.loadtestToken) {
    console.log('  Loadtest token: set (rate limit bypass enabled)');
  }
  if (config.skipCerebras) {
    console.log('  Skip Cerebras: YES (dummy content mode — RAG still runs)');
  }
  if (config.skipPipeline) {
    console.log('  Skip Pipeline: YES (full bypass — no rate-limit, RAG, or LLM)');
  }
  if (config.mode === 'http') {
    console.log(`  Mode:          HTTP (direct fetch, no browser) → ${config.workerUrl}`);
  }

  if (config.rate > 0.5 && !config.loadtestToken) {
    console.log(`\n  ⚠ Rate ${config.rate}/s exceeds the backend limit of 30/60s (0.5/s).`);
    if (config.rate <= 5) {
      console.log('    Using burst-then-wait strategy: 28 requests per 60s window.');
    }
    console.log('    Expect 429 responses unless rate limit is bypassed on the worker.');
  }

  // Estimate duration: max of rate-limited time vs execution time with parallelism
  const AVG_REQUEST_SECONDS = 2.5;
  const rateLimitedSeconds = config.total / config.rate;
  const executionSeconds = (config.total * AVG_REQUEST_SECONDS) / config.parallel;
  const estimatedSeconds = Math.max(rateLimitedSeconds, executionSeconds);
  const estMin = Math.floor(estimatedSeconds / 60);
  const estSec = Math.ceil(estimatedSeconds % 60);
  const estStr = estMin > 0 ? `${estMin}m ${estSec}s` : `${estSec}s`;
  console.log(`\n  Estimated duration: ~${estStr} (assuming ~${AVG_REQUEST_SECONDS}s per request)`);
  console.log('================================\n');
}
