import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function errorCode(result) {
  const src = result.errorSource || 'unknown';
  const e = (result.error || '').toLowerCase();
  const status = result.apiStatus || result.httpStatus;

  let code;
  if (status === 429 || e.includes('429') || e.includes('rate limit')) code = '429';
  else if (status === 425 || e.includes('425')) code = '425';
  else if (status >= 500 || e.includes('50')) code = String(status || '5xx');
  else if (e.includes('timeout') || e.includes('timed out')) code = 'timeout';
  else if (e.includes('abort')) code = 'abort';
  else if (e.includes('net::') || e.includes('econnrefused') || e.includes('econnreset')) code = 'net';
  else code = status ? String(status) : 'err';

  return `${src}/${code}`;
}

export class Reporter {
  constructor(outputDir) {
    this.outputDir = outputDir;
    this.results = [];
    this.startTime = Date.now();
    this.testStartTime = null; // set by onTestStart(), excludes browser init
  }

  onTestStart() {
    this.testStartTime = Date.now();
  }

  onResult(result, completed, total) {
    this.results.push(result);
    const elapsed = ((Date.now() - (this.testStartTime || this.startTime)) / 1000).toFixed(1);
    const dur = (result.totalDuration / 1000).toFixed(1);
    const query = result.query.length > 50 ? `${result.query.slice(0, 50)}...` : result.query;
    const sections = result.sectionCount != null ? ` (${result.sectionCount} sections)` : '';
    const errorInfo = result.error ? ` [${errorCode(result)}]` : '';

    const tag = result.status === 'success' ? 'SUCCESS' : 'ERROR  ';
    process.stderr.write(
      `[+${elapsed}s] [${completed}/${total}] ${tag}  ${dur}s  "${query}"${sections}${errorInfo}\n`,
    );
  }

  async writeReports(config, rateLimiterStats) {
    const endTime = Date.now();
    const successes = this.results.filter((r) => r.status === 'success');
    const errors = this.results.filter((r) => r.status !== 'success');

    const durations = successes.map((r) => r.totalDuration).sort((a, b) => a - b);
    const firstSections = successes
      .map((r) => r.timestamps.firstSection - r.timestamps.navigationStart)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    const sectionCounts = successes.map((r) => r.sectionCount).filter((v) => v != null);

    // Phase breakdown: where does time go within each request?
    const phasePageLoad = successes // navigationStart → domContentLoaded
      .map((r) => (r.timestamps.domContentLoaded || 0) - r.timestamps.navigationStart)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    const phaseApiResponse = successes // domContentLoaded → firstSection
      .map((r) => (r.timestamps.firstSection || 0) - (r.timestamps.domContentLoaded || r.timestamps.navigationStart))
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    const phaseStreaming = successes // firstSection → streamComplete
      .map((r) => (r.timestamps.streamComplete || 0) - (r.timestamps.firstSection || 0))
      .filter((v) => v > 0)
      .sort((a, b) => a - b);

    const totalDurationMs = endTime - this.startTime;
    const testDurationMs = endTime - (this.testStartTime || this.startTime);
    const testDurationMin = testDurationMs / 60_000;
    const pagesPerMinute = testDurationMin > 0 ? (successes.length / testDurationMin) : 0;
    const pagesPerSecond = testDurationMs > 0 ? (successes.length / (testDurationMs / 1000)) : 0;

    const report = {
      meta: {
        startTime: new Date(this.startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        totalDurationMs,
        testDurationMs,
        durationFormatted: formatDuration(totalDurationMs),
        testDurationFormatted: formatDuration(testDurationMs),
        config,
        rateLimiterStats,
      },
      summary: {
        total: this.results.length,
        success: successes.length,
        errors: errors.length,
        successRate: `${((successes.length / this.results.length) * 100).toFixed(1)}%`,
        pagesPerMinute: Math.round(pagesPerMinute * 10) / 10,
        pagesPerSecond: Math.round(pagesPerSecond * 10) / 10,
        timing: computeStats(durations),
        firstSectionTiming: computeStats(firstSections),
        sectionCounts: computeStats(sectionCounts),
        phases: {
          pageLoad: computeStats(phasePageLoad),
          apiResponse: computeStats(phaseApiResponse),
          streaming: computeStats(phaseStreaming),
        },
        ...categorizeErrors(errors),
        byCategory: this._categoryBreakdown(successes),
      },
      results: this.results,
    };

    // Write all reports in parallel
    await Promise.all([
      writeFile(join(this.outputDir, 'results.json'), JSON.stringify(report, null, 2)),
      writeFile(join(this.outputDir, 'errors.json'), JSON.stringify(errors, null, 2)),
      writeFile(join(this.outputDir, 'summary.txt'), formatSummary(report)),
    ]);

    // Print summary to stdout
    console.log(formatSummary(report));

    return report;
  }

  _categoryBreakdown(successes) {
    const cats = {};
    for (const r of successes) {
      const cat = r.category || 'unknown';
      if (!cats[cat]) cats[cat] = { count: 0, durations: [] };
      cats[cat].count++;
      cats[cat].durations.push(r.totalDuration);
    }
    const result = {};
    for (const [cat, data] of Object.entries(cats)) {
      result[cat] = {
        count: data.count,
        timing: computeStats(data.durations.sort((a, b) => a - b)),
      };
    }
    return result;
  }
}

function computeStats(sorted) {
  if (sorted.length === 0) return null;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round(sum / sorted.length),
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1],
    p99: sorted[Math.floor(sorted.length * 0.99)] || sorted[sorted.length - 1],
  };
}

function categorizeErrors(errors) {
  const byType = {};
  const bySource = {};
  for (const r of errors) {
    // By error type (what happened)
    let type = 'unknown';
    if (r.error?.includes('425') || r.apiStatus === 425) type = '425 too early';
    else if (r.error?.includes('429') || r.error?.includes('rate limit')) type = '429 rate limit';
    else if (r.error?.includes('timeout') || r.error?.includes('Timeout')) type = 'timeout';
    else if (r.error?.includes('net::') || r.error?.includes('ECONNREFUSED')) type = 'network';
    else if (r.error) type = 'other';
    byType[type] = (byType[type] || 0) + 1;

    // By error source (where it happened)
    const source = r.errorSource || 'unknown';
    bySource[source] = (bySource[source] || 0) + 1;
  }
  return { byType, bySource };
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const remaining = s % 60;
  return m > 0 ? `${m}m ${remaining}s` : `${s}s`;
}

function formatSummary(report) {
  const { summary, meta } = report;
  const initMs = meta.totalDurationMs - meta.testDurationMs;
  const initStr = initMs > 1000 ? ` (browser init: ${formatDuration(initMs)})` : '';
  const lines = [
    '=== Load Test Summary ===',
    '',
    `Duration:     ${meta.testDurationFormatted}${initStr}`,
    `Total:        ${summary.total}`,
    `Success:      ${summary.success} (${summary.successRate})`,
    `Errors:       ${summary.errors}`,
    `Throughput:   ${summary.pagesPerMinute} pages/min  (${summary.pagesPerSecond} pages/s)`,
    '',
  ];

  if (summary.timing) {
    lines.push('Timing (total page load):');
    lines.push(`  Min:    ${(summary.timing.min / 1000).toFixed(1)}s`);
    lines.push(`  Mean:   ${(summary.timing.mean / 1000).toFixed(1)}s`);
    lines.push(`  Median: ${(summary.timing.median / 1000).toFixed(1)}s`);
    lines.push(`  P95:    ${(summary.timing.p95 / 1000).toFixed(1)}s`);
    lines.push(`  P99:    ${(summary.timing.p99 / 1000).toFixed(1)}s`);
    lines.push(`  Max:    ${(summary.timing.max / 1000).toFixed(1)}s`);
    lines.push('');
  }

  if (summary.firstSectionTiming) {
    lines.push('Time to first section:');
    lines.push(`  Min:    ${(summary.firstSectionTiming.min / 1000).toFixed(1)}s`);
    lines.push(`  Mean:   ${(summary.firstSectionTiming.mean / 1000).toFixed(1)}s`);
    lines.push(`  Median: ${(summary.firstSectionTiming.median / 1000).toFixed(1)}s`);
    lines.push(`  P95:    ${(summary.firstSectionTiming.p95 / 1000).toFixed(1)}s`);
    lines.push('');
  }

  const { phases } = summary;
  if (phases?.pageLoad || phases?.apiResponse) {
    const ms = (v) => (v != null ? `${(v / 1000).toFixed(2)}s` : 'n/a');
    lines.push('Timing phases (mean → p95):');
    if (phases.pageLoad) {
      lines.push(`  Page load   (nav → DOMContentLoaded):  ${ms(phases.pageLoad.mean)} → ${ms(phases.pageLoad.p95)}`);
    }
    if (phases.apiResponse) {
      lines.push(`  API response (DOM → 1st section):       ${ms(phases.apiResponse.mean)} → ${ms(phases.apiResponse.p95)}`);
    }
    if (phases.streaming) {
      lines.push(`  Streaming   (1st section → done):       ${ms(phases.streaming.mean)} → ${ms(phases.streaming.p95)}`);
    }
    lines.push('');
  }

  if (summary.errors > 0) {
    lines.push('Errors by type (what happened):');
    for (const [type, count] of Object.entries(summary.byType)) {
      lines.push(`  ${type}: ${count}`);
    }
    lines.push('');
    lines.push('Errors by source (where it happened):');
    for (const [source, count] of Object.entries(summary.bySource)) {
      lines.push(`  ${source}: ${count}`);
    }
    lines.push('');
  }

  if (Object.keys(summary.byCategory).length > 0) {
    lines.push('By category:');
    for (const [cat, data] of Object.entries(summary.byCategory)) {
      const mean = data.timing ? `${(data.timing.mean / 1000).toFixed(1)}s avg` : 'n/a';
      lines.push(`  ${cat}: ${data.count} requests, ${mean}`);
    }
    lines.push('');
  }

  lines.push(`Rate limiter: ${meta.rateLimiterStats?.sent || 0} sent, `
    + `${meta.rateLimiterStats?.throttled || 0} throttled, `
    + `${meta.rateLimiterStats?.backoffs || 0} backoffs`);
  lines.push('========================');

  return lines.join('\n');
}
