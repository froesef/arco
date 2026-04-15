#!/usr/bin/env node

/**
 * Load Testing Workbench — Main Orchestrator
 *
 * Usage:
 *   node tools/loadtest/loadtest.js [options]
 *
 * Options:
 *   --total N          Total requests (default: 1000)
 *   --rate N           Max requests/second (default: 0.5)
 *   --parallel N       Concurrent browser contexts (default: 3)
 *   --base-url URL     Target URL (default: https://main--arco--froesef.aem.live)
 *   --timeout N        Per-page timeout in ms (default: 120000)
 *   --no-screenshots   Disable screenshots
 *   --regen            Append &regen to force regeneration
 *   --no-headless      Show browser windows
 *   --dry-run          Print config and sample prompts, then exit
 *   --output DIR       Output directory (default: tools/loadtest/results)
 *   --prompts FILE     Prompt file (default: tools/loadtest/prompts.json)
 *
 * Examples:
 *   node tools/loadtest/loadtest.js --total 10 --parallel 2 --no-headless
 *   node tools/loadtest/loadtest.js --total 1000 --rate 0.5 --parallel 8
 */

import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseConfig, printConfig } from './config.js';
import { RateLimiter } from './rate-limiter.js';
import { BrowserPool } from './browser-pool.js';
import { Reporter } from './reporter.js';
import { testSingleQueryHTTP, Semaphore } from './http-tester.js';

// --- Utilities ---

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function shuffle(arr, seed = 42) {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- Error source classification ---

function classifyErrorSource(result) {
  const err = (result.error || '').toLowerCase();
  const consoleMsgs = result.consoleLogs.map((l) => l.text.toLowerCase()).join(' ');

  // Cerebras / LLM errors — the worker wraps these with specific messages
  if (err.includes('ai service') || err.includes('ai rate limit')
      || err.includes('ai request timed out') || err.includes('ai authentication')
      || consoleMsgs.includes('ai service') || consoleMsgs.includes('ai rate limit')
      || consoleMsgs.includes('ai request timed out')) {
    return 'cerebras';
  }

  // 425 Too Early — TLS/edge level
  if (result.apiStatus === 425 || result.httpStatus === 425 || err.includes('425')) {
    return 'network';
  }

  // 429 rate limit — worker-level
  if (result.apiStatus === 429 || err.includes('429') || err.includes('rate limit')) {
    return 'worker';
  }

  // Worker/server errors (5xx)
  if (result.apiStatus >= 500 || result.httpStatus >= 500) {
    return 'worker';
  }

  // Client-side timeout — no server error, just waited too long
  if (err.includes('timeout') || err.includes('waiting for selector')) {
    // Check if there's a hint of what the server was doing
    if (consoleMsgs.includes('ai service') || consoleMsgs.includes('ai request')
        || consoleMsgs.includes('ai rate limit')) {
      return 'cerebras';
    }
    // If we got first section but timed out waiting for completion, likely LLM slow
    if (result.timestamps.firstSection && !result.timestamps.streamComplete) {
      return 'cerebras';
    }
    // If page loaded but no sections ever streamed, the pipeline is stuck
    // at the LLM step (most common cause under load)
    if (result.timestamps.domContentLoaded && !result.timestamps.firstSection) {
      return 'cerebras';
    }
    return 'client';
  }

  // Network-level errors
  if (err.includes('net::') || err.includes('econnrefused') || err.includes('econnreset')
      || err.includes('err_connection') || err.includes('too early')) {
    return 'network';
  }

  return 'unknown';
}

// --- Single page test ---

async function testSingleQuery(context, prompt, config, outputDir) {
  const page = await context.newPage();
  const result = {
    id: prompt.id,
    query: prompt.query,
    category: prompt.category,
    startTime: Date.now(),
    timestamps: {},
    status: 'pending',
    error: null,
    errorSource: null, // 'cerebras' | 'vectorize' | 'worker' | 'network' | 'client'
    consoleLogs: [],
    screenshotPath: null,
    sectionCount: null,
    pageTitle: null,
    serverReportedTime: null,
    serverTimings: null, // detailed backend timings from debug NDJSON
    totalDuration: null,
  };

  page.on('console', (msg) => {
    const entry = { type: msg.type(), text: msg.text(), time: Date.now() };
    // Try to capture structured args (e.g. the timings object)
    const args = msg.args();
    if (args.length > 1) {
      args[1].jsonValue().then((val) => { entry.data = val; }).catch(() => {});
    }
    result.consoleLogs.push(entry);
  });

  // Track HTTP responses for error detection
  const apiResponses = [];
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/api/generate') || url.includes('/?q=')) {
      apiResponses.push({ url, status: response.status(), statusText: response.statusText() });
    }
  });

  try {
    const urlParams = new URLSearchParams({ q: prompt.query });
    if (config.regen) urlParams.append('regen', '');
    const url = `${config.baseUrl}/?${urlParams.toString()}`;

    // Navigate
    result.timestamps.navigationStart = Date.now();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.timeout });
    result.timestamps.domContentLoaded = Date.now();
    result.httpStatus = response?.status() || null;

    // Check for HTTP-level errors before waiting for content
    if (result.httpStatus === 425) {
      throw new Error('425 Too Early — TLS connection not ready');
    }
    if (result.httpStatus >= 500) {
      throw new Error(`${result.httpStatus} Server Error`);
    }

    // Wait for first section (spinner gets 'done' class)
    await page.waitForSelector('.generating-container.done, .section[data-section-status]', {
      timeout: config.timeout,
    });
    result.timestamps.firstSection = Date.now();

    // Wait for stream completion — follow-up suggestions appear
    await page.waitForSelector('.follow-up-container', { timeout: config.timeout });
    result.timestamps.streamComplete = Date.now();

    // Wait briefly for the spinner to be removed (stream fully done)
    await page.waitForSelector('.generating-container', { state: 'detached', timeout: 5000 })
      .catch(() => { /* may already be removed */ });

    // Extract completion time and server timings from console
    const completeLog = result.consoleLogs.find(
      (l) => l.text.includes('[Recommender] Complete'),
    );
    if (completeLog) {
      const match = completeLog.text.match(/Complete in ([\d.]+)s/);
      if (match) result.serverReportedTime = parseFloat(match[1]);
      if (completeLog.data) result.serverTimings = completeLog.data;
    }

    // Count sections
    result.sectionCount = await page.$$eval(
      '#generation-content > .section',
      (els) => els.length,
    ).catch(() => 0);

    // Page title
    result.pageTitle = await page.title().catch(() => null);

    // Screenshot
    if (config.screenshots) {
      const filename = `${String(prompt.id).padStart(4, '0')}-${slugify(prompt.query)}.jpeg`;
      result.screenshotPath = filename;
      await page.screenshot({
        path: join(outputDir, 'screenshots', filename),
        fullPage: true,
        type: 'jpeg',
        quality: 80,
      });
    }

    // Check if the API call had issues even though the page rendered
    const apiError = apiResponses.find((r) => r.status >= 400);
    if (apiError) {
      result.apiStatus = apiError.status;
    }

    result.status = 'success';
  } catch (err) {
    result.status = 'error';
    result.error = err.message;

    // Enrich with HTTP status info
    const apiError = apiResponses.find((r) => r.status >= 400);
    if (apiError) {
      result.apiStatus = apiError.status;
      if (apiError.status === 425 && !result.error.includes('425')) {
        result.error = `425 Too Early (API) — ${result.error}`;
      }
    }

    // Classify error source
    result.errorSource = classifyErrorSource(result);

    // Screenshot on error for debugging
    if (config.screenshots) {
      try {
        const filename = `error-${String(prompt.id).padStart(4, '0')}.jpeg`;
        result.screenshotPath = filename;
        await page.screenshot({
          path: join(outputDir, 'screenshots', filename),
          fullPage: true,
          type: 'jpeg',
          quality: 80,
        });
      } catch { /* ignore */ }
    }
  } finally {
    result.endTime = Date.now();
    result.totalDuration = result.endTime - result.startTime;
    await page.close().catch(() => {});
  }

  return result;
}

// --- Main ---

async function main() {
  const config = parseConfig();
  printConfig(config);

  // Load prompts
  const promptsPath = resolve(config.prompts);
  const allPrompts = JSON.parse(await readFile(promptsPath, 'utf-8'));
  if (!Array.isArray(allPrompts) || allPrompts.length === 0) {
    console.error(`Error: No prompts found in ${promptsPath}. Run: node tools/loadtest/generate-prompts.js`);
    process.exit(1);
  }
  console.log(`Loaded ${allPrompts.length} prompts from ${promptsPath}`);

  // Shuffle and slice
  const prompts = shuffle(allPrompts).slice(0, config.total);
  if (config.total > allPrompts.length) {
    console.warn(`Warning: Requested ${config.total} but only ${allPrompts.length} prompts available. Running ${prompts.length}.`);
  }
  console.log(`Selected ${prompts.length} prompts for this run\n`);

  // Dry run: print sample and exit
  if (config.dryRun) {
    console.log('--- Dry Run: Sample Prompts ---');
    const sample = prompts.slice(0, 10);
    for (const p of sample) {
      console.log(`  [${p.id}] (${p.category}) "${p.query}"`);
    }
    if (prompts.length > sample.length) {
      console.log(`  ... and ${prompts.length - sample.length} more`);
    }
    console.log('\nDry run complete. Remove --dry-run to execute.');
    return;
  }

  // Create output directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputDir = resolve(config.output, `run-${timestamp}`);
  await mkdir(config.mode === 'http' ? outputDir : join(outputDir, 'screenshots'), { recursive: true });
  console.log(`Output directory: ${outputDir}\n`);

  // Initialize components
  const rateLimiter = new RateLimiter(config.rate, { bypassServerLimit: !!config.loadtestToken });
  const reporter = new Reporter(outputDir);

  // Build a pool abstraction that works for both browser and HTTP modes
  let pool;
  if (config.mode === 'http') {
    const semaphore = new Semaphore(config.parallel);
    pool = {
      initialize: async () => {
        console.log(`[http-pool] Ready: ${config.parallel} concurrent slots`);
      },
      acquireContext: async () => { await semaphore.acquire(); return null; },
      releaseContext: () => semaphore.release(),
      shutdown: async () => {},
    };
  } else {
    pool = new BrowserPool({
      parallel: config.parallel,
      headless: config.headless,
      viewportWidth: config.viewportWidth,
      viewportHeight: config.viewportHeight,
      loadtestToken: config.loadtestToken,
      skipCerebras: config.skipCerebras,
      skipPipeline: config.skipPipeline,
    });
  }

  // Pick the test function based on mode
  const runTest = config.mode === 'http'
    ? (_ctx, prompt) => testSingleQueryHTTP(prompt, config)
    : (ctx, prompt) => testSingleQuery(ctx, prompt, config, outputDir);

  let aborted = false;

  // Graceful shutdown on Ctrl+C: write partial results before exiting
  const handleSignal = async () => {
    if (aborted) return; // prevent double-handling
    aborted = true;
    console.error('\n\nInterrupted — writing partial results...\n');
    try {
      await reporter.writeReports(config, rateLimiter.getStats());
      console.log(`\nPartial results written to: ${outputDir}`);
    } catch (e) {
      console.error('Failed to write partial results:', e.message);
    }
    await pool.shutdown().catch(() => {});
    process.exit(130);
  };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  try {
    await pool.initialize();
    reporter.onTestStart();
    console.log('\nStarting load test...\n');

    // Work queue
    const inFlight = new Set();
    let completed = 0;

    for (const prompt of prompts) {
      if (aborted) break;
      await rateLimiter.acquire();
      if (aborted) break;
      const context = await pool.acquireContext();

      const promise = runTest(context, prompt)
        .then((result) => {
          completed++;
          reporter.onResult(result, completed, prompts.length);

          // If we got a 429, tell the rate limiter
          if (result.error && (result.error.includes('429') || result.error.includes('rate limit'))) {
            rateLimiter.record429();
          }

          pool.releaseContext(context);
          inFlight.delete(promise);
        });

      inFlight.add(promise);
    }

    // Wait for all in-flight
    await Promise.all(inFlight);

    if (!aborted) {
      console.log('\n--- Test Complete ---\n');

      // Write reports
      await reporter.writeReports(config, rateLimiter.getStats());
      console.log(`\nResults written to: ${outputDir}`);
    }
  } finally {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    if (!aborted) await pool.shutdown();
  }
}

main().catch((err) => {
  if (err.message?.includes('has been closed') || err.message?.includes('Target closed')) {
    // Browser was closed during shutdown — already handled
    return;
  }
  console.error('Fatal error:', err);
  process.exit(1);
});
