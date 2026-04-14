import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class Reporter {
  constructor(outputDir) {
    this.outputDir = outputDir;
    this.results = [];
    this.startTime = Date.now();
  }

  onResult(result, completed, total) {
    this.results.push(result);
    const dur = (result.totalDuration / 1000).toFixed(1);
    const query = result.query.length > 50 ? `${result.query.slice(0, 50)}...` : result.query;
    const sections = result.sectionCount != null ? ` (${result.sectionCount} sections)` : '';
    const source = result.errorSource ? `[${result.errorSource}] ` : '';
    const errorInfo = result.error ? ` (${source}${result.error.slice(0, 40)})` : '';

    const tag = result.status === 'success' ? 'SUCCESS' : 'ERROR  ';
    process.stderr.write(
      `[${completed}/${total}] ${tag}  ${dur}s  "${query}"${sections}${errorInfo}\n`,
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

    const durationMs = endTime - this.startTime;
    const durationMin = durationMs / 60_000;
    const pagesPerMinute = durationMin > 0 ? (successes.length / durationMin) : 0;

    const report = {
      meta: {
        startTime: new Date(this.startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        durationMs,
        durationFormatted: formatDuration(durationMs),
        config,
        rateLimiterStats,
      },
      summary: {
        total: this.results.length,
        success: successes.length,
        errors: errors.length,
        successRate: `${((successes.length / this.results.length) * 100).toFixed(1)}%`,
        pagesPerMinute: Math.round(pagesPerMinute * 10) / 10,
        timing: computeStats(durations),
        firstSectionTiming: computeStats(firstSections),
        sectionCounts: computeStats(sectionCounts),
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
  const lines = [
    '=== Load Test Summary ===',
    '',
    `Duration:     ${meta.durationFormatted}`,
    `Total:        ${summary.total}`,
    `Success:      ${summary.success} (${summary.successRate})`,
    `Errors:       ${summary.errors}`,
    `Throughput:   ${summary.pagesPerMinute} pages/min`,
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
