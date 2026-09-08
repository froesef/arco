/**
 * Admin Block — Audience of One Admin.
 *
 * Unified admin for the Arco recommender demo, covering:
 *   1. Sessions / pages / runs — browse recorded sessions and reconstruct pages
 *   2. Model settings — runtime provider/model/temperature/maxTokens switch
 *   3. Vectorize — inspect the `arco-content` index, run similarity searches
 *
 * Authenticates against the recommender worker's /api/admin/* endpoints
 * using HTTP Basic Auth (username: admin, password: ADMIN_TOKEN). The token
 * is prompted once and cached in localStorage.
 *
 * Hierarchy (sessions section):
 *   session (one browser tab)
 *     └─ page (one ?q= URL visit)
 *         └─ run (one /api/generate call — initial or a follow-up click)
 *
 * Hash routes:
 *   #/                         Sessions list (default)
 *   #/sessions/:id             Session detail + pages list
 *   #/pages/:id[/:tab]         Page detail — overview / reconstruction / timeline / debug
 *   #/llm-config               Model settings
 *   #/experiments              Experiments list (multi-model A/B)
 *   #/experiments/new          New experiment form + live run
 *   #/experiments/:id          Experiment detail (flip-through variants)
 *   #/experiments/:id/variants/:variantId  Deep link to a specific variant
 *   #/evaluations              LLM Evaluation runs (multi-query × multi-model + judge)
 *   #/evaluations/new          New evaluation form + live run
 *   #/evaluations/:id          Evaluation detail (matrix view)
 *   #/vectorize                Vectorize overview (index stats + sampled histogram)
 *   #/vectorize/search[?...]   Vectorize similarity search
 *   #/vectorize/items/:id      Vectorize item detail
 */

import {
  decorateBlock, decorateButtons, decorateIcons, loadBlock,
} from '../../scripts/aem.js';
import { ARCO_RECOMMENDER_URL } from '../../scripts/api-config.js';
import { BLOCK_ALIASES } from '../../scripts/block-aliases.js';
import { formatTimestamp as ts, formatDuration, formatInt as fmtInt } from '../../scripts/formatting.js';
import { processSectionMetadata } from '../../scripts/section-metadata.js';

const TOKEN_STORAGE_KEY = 'arco-admin-token';

// ── Helpers ─────────────────────────────────────────────────────────────────

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const dur = (ms) => formatDuration(ms);
const vecDur = (ms) => formatDuration(ms, 2);

function badge(label, tone = 'neutral') {
  if (!label && label !== 0) return '<span class="admin-badge admin-badge-muted">—</span>';
  return `<span class="admin-badge admin-badge-${tone}">${esc(label)}</span>`;
}

function vecBadge(label, tone = 'muted') {
  if (label === null || label === undefined || label === '') {
    return '<span class="vec-badge vec-badge-muted">—</span>';
  }
  return `<span class="vec-badge vec-badge-${tone}">${esc(label)}</span>`;
}

function kv(label, value) {
  const v = value === null || value === undefined || value === '' ? '—' : esc(value);
  return `<div class="admin-kv"><dt>${esc(label)}</dt><dd>${v}</dd></div>`;
}

function intentTone(intent) {
  const map = {
    espresso: 'accent',
    'milk-drinks': 'purple',
    comparison: 'warn',
    grinder: 'ok',
    gift: 'warn',
    beginner: 'ok',
    support: 'muted',
  };
  return map[intent] || 'accent';
}

function typeTone(type) {
  const map = {
    guide: 'ok',
    experience: 'purple',
    comparison: 'warn',
    product: 'accent',
    recipe: 'ok',
    'hero-image': 'purple',
    maintenance: 'warn',
    diagnostic: 'warn',
    pairing: 'accent',
    calculator: 'muted',
  };
  return map[type] || 'accent';
}

// ── Auth ────────────────────────────────────────────────────────────────────

function getAdminToken() {
  let token = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!token) {
    // eslint-disable-next-line no-alert
    token = window.prompt('Admin token (ADMIN_TOKEN secret):');
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
  }
  return token;
}

function clearAdminToken() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

async function api(path, options = {}) {
  const token = getAdminToken();
  if (!token) throw new Error('Admin token required');
  const headers = {
    Authorization: `Basic ${btoa(`admin:${token}`)}`,
    ...(options.headers || {}),
  };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${ARCO_RECOMMENDER_URL}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body,
  });
  if (res.status === 401) {
    clearAdminToken();
    throw new Error('Unauthorized — token cleared. Reload to retry.');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Routing ─────────────────────────────────────────────────────────────────

function parseRoute() {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  if (hash === '/' || hash === '/sessions') return { view: 'sessions' };
  if (hash === '/llm-config') return { view: 'llm-config' };

  const sessionMatch = hash.match(/^\/sessions\/([^/]+)$/);
  if (sessionMatch) return { view: 'session', id: sessionMatch[1] };

  const pageMatch = hash.match(/^\/pages\/([^/]+)(?:\/(\w+))?$/);
  if (pageMatch) return { view: 'page', id: pageMatch[1], tab: pageMatch[2] || 'overview' };

  if (hash === '/experiments') return { view: 'experiments' };
  if (hash === '/experiments/new' || hash.startsWith('/experiments/new?')) {
    return { view: 'experiment-new' };
  }
  const expVariantMatch = hash.match(/^\/experiments\/([^/]+)\/variants\/([^/]+)$/);
  if (expVariantMatch) {
    return { view: 'experiment', id: expVariantMatch[1], variantId: expVariantMatch[2] };
  }
  const expMatch = hash.match(/^\/experiments\/([^/]+)$/);
  if (expMatch) return { view: 'experiment', id: expMatch[1] };

  if (hash === '/evaluations') return { view: 'evaluations' };
  if (hash === '/evaluations/new' || hash.startsWith('/evaluations/new?')) {
    return { view: 'evaluation-new' };
  }
  const evalMatch = hash.match(/^\/evaluations\/([^/]+)$/);
  if (evalMatch) return { view: 'evaluation', id: evalMatch[1] };

  if (hash === '/vectorize' || hash === '/vectorize/overview') return { view: 'vec-overview' };
  if (hash === '/vectorize/search' || hash.startsWith('/vectorize/search?')) return { view: 'vec-search' };

  const itemMatch = hash.match(/^\/vectorize\/items\/(.+)$/);
  if (itemMatch) return { view: 'vec-item', id: decodeURIComponent(itemMatch[1]) };

  if (hash === '/feedback' || hash.startsWith('/feedback?')) return { view: 'feedback' };
  const fbRunMatch = hash.match(/^\/feedback\/run\/([^/]+)$/);
  if (fbRunMatch) return { view: 'feedback-run', id: fbRunMatch[1] };
  if (hash === '/insights' || hash.startsWith('/insights?')) return { view: 'insights' };

  return { view: 'sessions' };
}

function navigate(hash) {
  window.location.hash = hash;
}

// ── Sessions list ───────────────────────────────────────────────────────────

async function renderSessions(root) {
  root.innerHTML = '<p class="admin-loading">Loading sessions…</p>';
  let data;
  try {
    data = await api('/api/admin/sessions?limit=100&offset=0');
  } catch (err) {
    root.innerHTML = `<p class="admin-error">${esc(err.message)}</p>`;
    return;
  }

  const sessions = data.sessions || [];
  const total = data.total || 0;

  root.innerHTML = `
    <div class="admin-toolbar">
      <h2>Sessions</h2>
      <div class="admin-stats">
        <span class="admin-stat"><span class="admin-stat-value">${total}</span><span class="admin-stat-label">total</span></span>
      </div>
    </div>
    ${sessions.length === 0
    ? '<p class="admin-empty">No sessions yet. Generate a recommender page first.</p>'
    : `<div class="admin-table-wrap"><table class="admin-table">
        <thead><tr>
          <th>Session</th><th>First seen</th><th>Last active</th>
          <th>Runs</th><th>User agent</th>
        </tr></thead>
        <tbody>${sessions.map((s) => `
          <tr data-href="#/sessions/${esc(s.id)}">
            <td class="admin-mono">${esc(s.id.substring(0, 8))}…</td>
            <td>${ts(s.first_seen)}</td>
            <td>${ts(s.last_seen)}</td>
            <td>${badge(s.page_count, s.page_count > 0 ? 'accent' : 'muted')}</td>
            <td class="admin-ua">${esc((s.user_agent || '').substring(0, 80))}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>`}
  `;

  root.querySelectorAll('tr[data-href]').forEach((tr) => {
    tr.addEventListener('click', () => { navigate(tr.dataset.href); });
  });
}

// ── Session detail (shows pages — grouped runs) ─────────────────────────────

async function renderSession(root, sessionId) {
  root.innerHTML = '<p class="admin-loading">Loading session…</p>';
  let data;
  try {
    data = await api(`/api/admin/sessions/${sessionId}`);
  } catch (err) {
    root.innerHTML = `<p class="admin-error">${esc(err.message)}</p>`;
    return;
  }

  const s = data.session;
  const pages = data.pages || [];
  const totalRuns = pages.reduce((n, p) => n + p.runCount, 0);

  root.innerHTML = `
    <nav class="admin-crumbs"><a href="#/">← Sessions</a></nav>
    <div class="admin-toolbar">
      <h2>Session ${esc(s.id.substring(0, 8))}…</h2>
      <div class="admin-stats">
        <span class="admin-stat"><span class="admin-stat-value">${pages.length}</span><span class="admin-stat-label">pages</span></span>
        <span class="admin-stat"><span class="admin-stat-value">${totalRuns}</span><span class="admin-stat-label">runs</span></span>
        <span class="admin-stat"><span class="admin-stat-value">${ts(s.first_seen)}</span><span class="admin-stat-label">first seen</span></span>
      </div>
    </div>

    <section class="admin-card">
      <h3>Session info</h3>
      <dl class="admin-kvs">
        ${kv('Session ID', s.id)}
        ${kv('IP hash', s.ip_hash)}
        ${kv('User agent', s.user_agent)}
      </dl>
    </section>

    <section class="admin-card">
      <h3>Pages</h3>
      ${pages.length === 0
    ? '<p class="admin-empty">No pages recorded for this session.</p>'
    : `<div class="admin-table-wrap"><table class="admin-table">
          <thead><tr>
            <th>#</th><th>Initial query</th><th>URL</th><th>Intent</th>
            <th>Runs</th><th>Total duration</th><th>Total tokens</th><th>Last activity</th>
          </tr></thead>
          <tbody>${pages.map((p, i) => `
            <tr data-href="#/pages/${esc(p.pageId)}">
              <td class="admin-muted">${i + 1}</td>
              <td class="admin-query">${esc(p.initialQuery || '')}</td>
              <td class="admin-url admin-mono" title="${esc(p.pageUrl || '')}">${esc((p.pageUrl || '').substring(0, 40))}</td>
              <td>${badge(p.initialIntent, intentTone(p.initialIntent))}</td>
              <td>${badge(p.runCount, p.runCount > 1 ? 'accent' : 'muted')}</td>
              <td>${dur(p.totalDurationMs)}</td>
              <td class="admin-muted">${p.totalInputTokens + p.totalOutputTokens > 0 ? `${p.totalInputTokens}↑ ${p.totalOutputTokens}↓` : '—'}</td>
              <td class="admin-muted">${ts(p.lastRunAt)}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>`}
    </section>
  `;

  root.querySelectorAll('tr[data-href]').forEach((tr) => {
    tr.addEventListener('click', () => { navigate(tr.dataset.href); });
  });
}

// ── Render a single stored block into a container ──────────────────────────

async function renderStoredSection(blockData, container) {
  const section = document.createElement('div');
  section.className = 'section';
  if (blockData.sectionStyle && blockData.sectionStyle !== 'default') {
    section.classList.add(blockData.sectionStyle);
  }
  section.dataset.sectionStatus = 'initialized';
  section.innerHTML = blockData.html;

  processSectionMetadata(section);

  const blockEl = section.querySelector('[class]');
  if (blockEl) {
    const origName = blockEl.classList[0];
    const alias = origName in BLOCK_ALIASES ? BLOCK_ALIASES[origName] : origName;
    if (alias === false) {
      blockEl.replaceWith(...blockEl.children);
    } else {
      const blockName = alias;
      if (blockName !== origName) blockEl.classList.replace(origName, blockName);
      const wrapper = document.createElement('div');
      wrapper.className = `${blockName}-wrapper`;
      blockEl.parentNode.insertBefore(wrapper, blockEl);
      wrapper.appendChild(blockEl);
      decorateBlock(blockEl);
      section.classList.add(`${blockName}-container`);
    }
  }

  decorateButtons(section);
  decorateIcons(section);
  container.appendChild(section);

  const block = section.querySelector('.block');
  if (block) {
    try {
      await loadBlock(block);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('Failed to load block:', err);
    }
  }
  section.dataset.sectionStatus = 'loaded';
}

/**
 * Render an inert "follow-up chips" marker showing which options were presented
 * and which one the user clicked (if any). Used in reconstruction mode.
 */
function renderFollowUpChips(options, clickedNext, container) {
  if (!options || options.length === 0) return;
  const section = document.createElement('div');
  section.className = 'section admin-followup-marker';

  const label = document.createElement('div');
  label.className = 'admin-followup-label';
  label.textContent = 'Keep exploring — options shown';
  section.appendChild(label);

  const list = document.createElement('div');
  list.className = 'admin-followup-chips';
  options.forEach((opt) => {
    const chip = document.createElement('span');
    chip.className = 'admin-followup-chip';
    const isClicked = clickedNext
      && (clickedNext.label === opt.label || clickedNext.query === (opt.query || opt.label));
    if (isClicked) chip.classList.add('is-clicked');
    chip.innerHTML = `
      <span class="admin-followup-type">${esc(opt.type || 'explore')}</span>
      <span class="admin-followup-text">${esc(opt.label || opt.query || '—')}</span>
      ${isClicked ? '<span class="admin-followup-arrow">↓ clicked</span>' : ''}
    `;
    list.appendChild(chip);
  });
  section.appendChild(list);
  container.appendChild(section);
}

// ── Page detail ─────────────────────────────────────────────────────────────

async function fetchPage(pageId) {
  return api(`/api/admin/pages/${pageId}`);
}

function renderOverviewTab(container, data) {
  const { runs } = data;
  const totalDuration = runs.reduce((n, r) => n + (r.run?.duration_ms || 0), 0);
  const totalIn = runs.reduce((n, r) => n + (r.run?.input_tokens || 0), 0);
  const totalOut = runs.reduce((n, r) => n + (r.run?.output_tokens || 0), 0);
  const totalBlocks = runs.reduce((n, r) => n + (r.run?.block_count || 0), 0);

  container.innerHTML = `
    <div class="admin-stats admin-stats-strip">
      <span class="admin-stat"><span class="admin-stat-value">${runs.length}</span><span class="admin-stat-label">runs</span></span>
      <span class="admin-stat"><span class="admin-stat-value">${totalBlocks}</span><span class="admin-stat-label">blocks total</span></span>
      <span class="admin-stat"><span class="admin-stat-value">${dur(totalDuration)}</span><span class="admin-stat-label">total duration</span></span>
      <span class="admin-stat"><span class="admin-stat-value">${totalIn}</span><span class="admin-stat-label">in tokens</span></span>
      <span class="admin-stat"><span class="admin-stat-value">${totalOut}</span><span class="admin-stat-label">out tokens</span></span>
    </div>

    <section class="admin-card">
      <h3>Page metadata</h3>
      <dl class="admin-kvs admin-kvs-two">
        ${kv('Page ID', data.pageId)}
        ${kv('Session', data.sessionId)}
        ${kv('URL', data.pageUrl)}
        ${kv('Initial query', runs[0]?.run?.query)}
        ${kv('Title', runs[0]?.run?.title)}
        ${kv('Started', ts(runs[0]?.run?.created_at))}
        ${kv('Ended', ts(runs[runs.length - 1]?.run?.created_at))}
      </dl>
    </section>
  `;
}

async function renderReconstructionTab(container, data) {
  container.innerHTML = '<p class="admin-loading">Reconstructing page…</p>';
  const stage = document.createElement('div');
  stage.className = 'admin-preview-stage';
  const main = document.createElement('main');
  main.className = 'admin-preview-main';
  stage.appendChild(main);
  container.innerHTML = '';
  container.appendChild(stage);

  const runs = data.runs || [];
  if (runs.length === 0) {
    main.innerHTML = '<p class="admin-empty">No runs stored for this page.</p>';
    return;
  }

  for (let i = 0; i < runs.length; i += 1) {
    const { run, payload } = runs[i];
    const blocks = payload?.blocks || [];

    // Divider between runs (showing which follow-up triggered this one)
    if (i > 0) {
      const divider = document.createElement('div');
      divider.className = 'section admin-run-divider';
      const clickedLabel = run.follow_up_label || run.query;
      divider.innerHTML = `
        <div class="admin-run-divider-line"></div>
        <div class="admin-run-divider-label">
          <span class="admin-run-divider-type">${esc(run.follow_up_type || 'follow-up')}</span>
          <span class="admin-run-divider-arrow">→</span>
          <span class="admin-run-divider-query">${esc(clickedLabel)}</span>
        </div>
      `;
      main.appendChild(divider);
    }

    // eslint-disable-next-line no-restricted-syntax
    for (const blockData of blocks) {
      // eslint-disable-next-line no-await-in-loop
      await renderStoredSection(blockData, main);
    }

    // After this run's blocks, show what follow-up chips were presented and which
    // one (if any) led to the next run.
    const nextRun = runs[i + 1]?.run || null;
    const clickedNext = nextRun
      ? { label: nextRun.follow_up_label, query: nextRun.query, type: nextRun.follow_up_type }
      : null;
    renderFollowUpChips(payload?.followUpOptions || [], clickedNext, main);
  }
}

function renderTimelineTab(container, data) {
  const runs = data.runs || [];
  container.innerHTML = `
    <section class="admin-card">
      <h3>Run timeline</h3>
      <p class="admin-muted">All generations on this page in order — initial run plus each follow-up click.</p>
      <ol class="admin-timeline">
        ${runs.map(({ run, payload }, i) => {
    const options = payload?.followUpOptions || [];
    const nextRun = runs[i + 1]?.run;
    const clickedNext = nextRun
      ? { label: nextRun.follow_up_label, query: nextRun.query, type: nextRun.follow_up_type }
      : null;
    return `
            <li class="admin-timeline-item">
              <div class="admin-timeline-marker">${run.run_index != null ? run.run_index : i}</div>
              <div class="admin-timeline-body">
                <div class="admin-timeline-head">
                  ${run.run_index === 0 || (run.run_index == null && i === 0)
    ? '<span class="admin-badge admin-badge-accent">initial</span>'
    : `${badge(run.follow_up_type || 'follow-up', 'purple')} <span class="admin-muted">${esc(run.follow_up_label || '')}</span>`}
                  <span class="admin-muted admin-mono">${ts(run.created_at)}</span>
                  <span class="admin-muted">${dur(run.duration_ms)}</span>
                  <span class="admin-muted">${run.input_tokens || '—'}↑ ${run.output_tokens || '—'}↓</span>
                </div>
                <p class="admin-timeline-query">${esc(run.query)}</p>
                <p class="admin-muted admin-timeline-title">${esc(run.title || '')}</p>
                ${options.length > 0 ? `
                  <div class="admin-timeline-options">
                    <div class="admin-muted admin-timeline-options-label">Follow-up options shown (${options.length})</div>
                    <div class="admin-followup-chips">
                      ${options.map((opt) => {
    const clickedOpt = clickedNext
      && (clickedNext.label === opt.label || clickedNext.query === (opt.query || opt.label));
    return `<span class="admin-followup-chip${clickedOpt ? ' is-clicked' : ''}">
                          <span class="admin-followup-type">${esc(opt.type || 'explore')}</span>
                          <span class="admin-followup-text">${esc(opt.label || opt.query || '—')}</span>
                          ${clickedOpt ? '<span class="admin-followup-arrow">↓ clicked</span>' : ''}
                        </span>`;
  }).join('')}
                    </div>
                  </div>` : ''}
                <details class="admin-timeline-details">
                  <summary>Run ${esc(run.id.substring(0, 8))}… (${run.block_count} blocks)</summary>
                  <dl class="admin-kvs admin-kvs-two">
                    ${kv('Run ID', run.id)}
                    ${kv('Parent run', run.parent_run_id)}
                    ${kv('Intent', run.intent_type)}
                    ${kv('Flow', run.flow_id)}
                    ${kv('Journey', run.journey_stage)}
                    ${kv('DA path', run.da_path)}
                  </dl>
                </details>
              </div>
            </li>`;
  }).join('')}
      </ol>
    </section>
  `;
}

// ── Debug tab helpers ──────────────────────────────────────────────────────

function buildLlmExport(run, payload) {
  const dbg = payload?.debug || {};
  const prompt = dbg.prompt || {};
  return {
    _meta: {
      exported_from: 'arco-admin',
      exported_at: new Date().toISOString(),
      run_id: run.id,
      query: run.query,
      source_provider: dbg.llm?.provider,
      source_model: dbg.llm?.model,
      temperature: dbg.llm?.temperature,
      max_tokens: dbg.llm?.maxTokens,
      timings_ms: dbg.timings,
      tokens: { input: dbg.llm?.inputTokens, output: dbg.llm?.outputTokens },
    },
    request: {
      model: dbg.llm?.model || 'claude-sonnet-4-6',
      max_tokens: dbg.llm?.maxTokens || 8192,
      temperature: dbg.llm?.temperature ?? 0.7,
      system: prompt.systemPrompt || '',
      messages: [{ role: 'user', content: prompt.userMessage || '' }],
    },
    reference_output: dbg.llm?.rawOutput || '',
  };
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

function timingTone(ms) {
  if (ms == null) return 'muted';
  if (ms < 100) return 'ok';
  if (ms < 500) return 'warn';
  return 'accent';
}

function renderKvList(rows) {
  return `<dl class="admin-kvs admin-kvs-two">${rows
    .map(([label, value]) => kv(label, value))
    .join('')}</dl>`;
}

function renderRagGroup(label, items) {
  const body = items?.length
    ? `<ul class="admin-rag-list">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`
    : '<span class="admin-muted">none</span>';
  return `<div class="admin-rag-group">
    <div class="admin-rag-label">${esc(label)}</div>
    ${body}
  </div>`;
}

function renderOverviewSection(dbg, run) {
  const intent = dbg.intent
    ? `${esc(dbg.intent.type)}${dbg.intent.confidence ? ` <span class="admin-muted">(${(dbg.intent.confidence * 100).toFixed(0)}%)</span>` : ''}`
    : '—';
  const totalMs = dbg.timings?.total;
  const llmMs = dbg.timings?.llm;
  const totalTokens = (dbg.llm?.inputTokens || 0) + (dbg.llm?.outputTokens || 0);
  const providerModel = dbg.llm?.provider
    ? `<span class="admin-mono">${esc(dbg.llm.provider)}</span> / ${esc(dbg.llm?.model || '—')}`
    : (dbg.llm?.model || '—');
  const tempStr = dbg.llm?.temperature != null ? String(dbg.llm.temperature) : '—';
  const maxStr = dbg.llm?.maxTokens != null ? String(dbg.llm.maxTokens) : '—';
  const rows = [
    ['Total time', `<span class="admin-badge admin-badge-${timingTone(totalMs)}">${fmtMs(totalMs)}</span>`],
    ['LLM time', `<span class="admin-badge admin-badge-${timingTone(llmMs)}">${fmtMs(llmMs)}</span>`],
    ['First token', fmtMs(dbg.timings?.llmFirstToken)],
    ['Provider / model', providerModel],
    ['Temperature', tempStr],
    ['Max tokens', maxStr],
    ['Flow', run.flow_id || '—'],
    ['Intent', intent],
    ['Journey stage', run.journey_stage || '—'],
    ['Tokens in / out', dbg.llm?.inputTokens != null
      ? `${dbg.llm.inputTokens} / ${dbg.llm.outputTokens}` : '—'],
    ['Total tokens', totalTokens || '—'],
    ['Output chars', (dbg.llm?.rawOutput || '').length || '—'],
    ['Sections', run.block_count || '—'],
  ];
  return `<div class="admin-card-sub">
    <h4>Overview</h4>
    <dl class="admin-kvs admin-kvs-two">
      ${rows.map(([l, v]) => `<div class="admin-kv"><dt>${esc(l)}</dt><dd>${v == null ? '—' : v}</dd></div>`).join('')}
    </dl>
  </div>`;
}

function renderSessionContextSection(request) {
  if (!request) return '';
  const prevQueries = request.previousQueries || [];
  const browsing = request.browsingHistory || [];
  const profile = request.inferredProfile || null;

  const groups = [];
  if (prevQueries.length) {
    groups.push(renderRagGroup(
      `Previous queries (${prevQueries.length})`,
      prevQueries.map((q) => {
        if (typeof q === 'string') return esc(q);
        return `${esc(q.query || '')} <span class="admin-muted">${esc(q.intent || '')}${q.journeyStage ? ` · ${esc(q.journeyStage)}` : ''}</span>`;
      }),
    ));
  }
  if (request.quizPersona) {
    groups.push(renderRagGroup('Quiz persona', [esc(request.quizPersona)]));
  }
  if (browsing.length) {
    groups.push(renderRagGroup(
      `Browsing history (${browsing.length})`,
      browsing.map((h) => {
        if (typeof h === 'string') return esc(h);
        const timeSpent = h.timeSpent ? `${Math.round(h.timeSpent / 1000)}s` : '';
        return `${esc(h.path || h.url || '')} <span class="admin-muted">${esc(h.intent || '')}${h.stage ? ` · ${esc(h.stage)}` : ''}${timeSpent ? ` · ${timeSpent}` : ''}</span>`;
      }),
    ));
  }
  if (request.followUp) {
    groups.push(renderRagGroup('Follow-up clicked', [
      `${esc(request.followUp.type || 'explore')} · ${esc(request.followUp.label || request.followUp.query || '')}`,
    ]));
  }
  if (profile) {
    groups.push(`<div class="admin-rag-group">
      <div class="admin-rag-label">Inferred profile</div>
      <pre class="admin-pre admin-pre-sm">${esc(JSON.stringify(profile, null, 2))}</pre>
    </div>`);
  }

  if (!groups.length) return '';
  return `<details class="admin-collapsible" open>
    <summary>Session context</summary>
    <div class="admin-card-sub-body">${groups.join('')}</div>
  </details>`;
}

function renderBehaviorSection(ba) {
  if (!ba) return '';
  const priceRange = ba.catalogPriceRange
    ? `$${ba.catalogPriceRange.min} – $${ba.catalogPriceRange.max}` : null;
  return `<details class="admin-collapsible">
    <summary>Behavior analysis</summary>
    <div class="admin-card-sub-body">${renderKvList([
    ['Cold start', ba.coldStart ? 'Yes' : 'No'],
    ['Price tier', ba.priceTier],
    ['Price range', priceRange],
    ['Journey stage', ba.journeyStage],
    ['Purchase readiness', ba.purchaseReadiness],
    ['Inferred intent', ba.inferredIntent],
    ['Use case priorities', (ba.useCasePriorities || []).join(', ')],
    ['Products viewed', (ba.productsViewed || []).join(', ')],
    ['Product shortlist', (ba.productShortlist || []).join(', ')],
  ])}</div>
  </details>`;
}

function renderPipelineStepsSection(timings) {
  const steps = timings?.steps || [];
  if (!steps.length) return '';
  return `<details class="admin-collapsible">
    <summary>Pipeline steps (${steps.length})</summary>
    <div class="admin-card-sub-body">
      <div class="admin-steps">
        ${steps.map((s) => `
          <div class="admin-step-row">
            <span class="admin-step-name">${esc(s.step)}${s.gate ? ' <span class="admin-badge admin-badge-muted">gate</span>' : ''}</span>
            <span class="admin-badge admin-badge-${timingTone(s.ms)}">${fmtMs(s.ms)}</span>
          </div>`).join('')}
      </div>
    </div>
  </details>`;
}

function renderRagSection(rag) {
  if (!rag) return '';
  const groups = [];

  const products = rag.products || [];
  groups.push(renderRagGroup(
    `Products (${products.length})`,
    products.map((p) => `${esc(p.name || p.id)} <span class="admin-muted">${esc(p.id || '')}${p.score != null ? ` · score ${Number(p.score).toFixed(2)}` : ''}${p.price ? ` · $${esc(p.price)}` : ''}</span>`),
  ));
  groups.push(renderRagGroup('Persona', rag.persona?.name ? [esc(rag.persona.name)] : []));
  groups.push(renderRagGroup('Use case', rag.useCase?.name ? [esc(rag.useCase.name)] : []));
  const features = rag.features || [];
  groups.push(renderRagGroup(
    `Features (${features.length})`,
    features.map((f) => `${esc(f.name)}${f.benefit ? `: <span class="admin-muted">${esc(f.benefit)}</span>` : ''}`),
  ));
  const faqs = rag.faqs || [];
  groups.push(renderRagGroup(
    `FAQs (${faqs.length})`,
    faqs.map((f) => esc(f.question || '')),
  ));
  const reviews = rag.reviews || [];
  groups.push(renderRagGroup(
    `Reviews (${reviews.length})`,
    reviews.map((r) => `${esc(r.author || '')} <span class="admin-muted">${esc(r.productId || r.product || '')}</span>`),
  ));
  const recipes = rag.recipes || [];
  groups.push(renderRagGroup(
    `Recipes (${recipes.length})`,
    recipes.map((r) => `${esc(r.name)}${r.score != null ? ` <span class="admin-muted">score ${Number(r.score).toFixed(2)}</span>` : ''}`),
  ));
  const guides = rag.guides || [];
  if (guides.length) {
    groups.push(renderRagGroup(
      `Guides (${guides.length})`,
      guides.map((g) => `${esc(g.title || g.slug || '')}${g.slug ? ` <span class="admin-muted">${esc(g.slug)}${g.score != null ? ` · score ${Number(g.score).toFixed(2)}` : ''}</span>` : ''}`),
    ));
  }
  const experiences = rag.experiences || [];
  if (experiences.length) {
    groups.push(renderRagGroup(
      `Experiences (${experiences.length})`,
      experiences.map((e) => `${esc(e.title || e.slug || '')}${e.slug ? ` <span class="admin-muted">${esc(e.slug)}${e.score != null ? ` · score ${Number(e.score).toFixed(2)}` : ''}</span>` : ''}`),
    ));
  }
  const comparisons = rag.comparisons || [];
  if (comparisons.length) {
    groups.push(renderRagGroup(
      `Comparisons (${comparisons.length})`,
      comparisons.map((c) => `${esc(c.title || c.slug || '')} <span class="admin-muted">${esc(c.source || 'vector')}</span>`),
    ));
  }
  const tools = rag.tools || [];
  if (tools.length) {
    groups.push(renderRagGroup(
      `Tools (${tools.length})`,
      tools.map((t) => `${esc(t.title || t.slug || '')}${t.score != null ? ` <span class="admin-muted">score ${Number(t.score).toFixed(2)}</span>` : ''}`),
    ));
  }
  const heroes = rag.heroImages || [];
  if (heroes.length) {
    groups.push(renderRagGroup(
      `Hero images (${heroes.length})`,
      heroes.map((h) => `${esc(h.id)}${h.score != null ? ` <span class="admin-muted">score ${Number(h.score).toFixed(2)}</span>` : ''}`),
    ));
  }

  return `<details class="admin-collapsible" open>
    <summary>RAG results</summary>
    <div class="admin-card-sub-body">${groups.join('')}</div>
  </details>`;
}

function renderSuggestionsSection(suggestions) {
  if (!suggestions?.length) return '';
  return `<details class="admin-collapsible">
    <summary>Follow-up suggestions shown (${suggestions.length})</summary>
    <div class="admin-card-sub-body">
      <div class="admin-followup-chips">
        ${suggestions.map((s) => `<span class="admin-followup-chip">
          <span class="admin-followup-type">${esc(s.type || 'explore')}</span>
          <span class="admin-followup-text">${esc(s.label || s.query || '')}</span>
        </span>`).join('')}
      </div>
    </div>
  </details>`;
}

function renderPromptSection(prompt) {
  if (!prompt || (!prompt.systemPrompt && !prompt.userMessage)) return '';
  return `<details class="admin-collapsible">
    <summary>Prompt (${prompt.systemLength || 0} + ${prompt.userLength || 0} chars)</summary>
    <div class="admin-card-sub-body">
      <h4>System prompt</h4>
      <pre class="admin-pre">${esc(prompt.systemPrompt || '(empty)')}</pre>
      <h4>User message</h4>
      <pre class="admin-pre">${esc(prompt.userMessage || '(empty)')}</pre>
    </div>
  </details>`;
}

function renderLlmOutputSection(llm) {
  if (!llm?.rawOutput) return '';
  return `<details class="admin-collapsible">
    <summary>Raw LLM output (${llm.rawOutput.length.toLocaleString()} chars)</summary>
    <div class="admin-card-sub-body">
      <pre class="admin-pre">${esc(llm.rawOutput)}</pre>
    </div>
  </details>`;
}

function renderDebugTab(container, data) {
  const runs = data.runs || [];
  if (runs.length === 0) {
    container.innerHTML = '<p class="admin-empty">No runs to inspect.</p>';
    return;
  }

  const runsData = runs;
  container.innerHTML = `
    <p class="admin-muted">Each run below captures its own intent, session context, RAG retrieval, pipeline timings, prompt and LLM output — the same data surfaced by the live <code>?debug=true</code> panel.</p>
    ${runs.map(({ run, payload }, i) => {
    const dbg = payload?.debug;
    const request = payload?.request;
    if (!dbg) {
      return `<section class="admin-card admin-run-debug">
        <h3>Run ${run.run_index != null ? run.run_index : i} — ${esc((run.query || '').substring(0, 80))}</h3>
        <p class="admin-empty">No debug snapshot stored for this run.</p>
      </section>`;
    }
    const label = run.run_index === 0 || (run.run_index == null && i === 0)
      ? '<span class="admin-badge admin-badge-accent">initial</span>'
      : `${badge(run.follow_up_type || 'follow-up', 'purple')} <span class="admin-muted">${esc(run.follow_up_label || '')}</span>`;
    return `
      <section class="admin-card admin-run-debug">
        <div class="admin-run-debug-head">
          <h3>Run ${run.run_index != null ? run.run_index : i} — ${esc((run.query || '').substring(0, 80))}</h3>
          <div class="admin-run-debug-head-right">
            <div class="admin-badges">${label}</div>
            ${dbg?.prompt?.systemPrompt ? `<button type="button" class="admin-btn admin-btn-ghost" data-export-run="${i}">Export for LLM</button>` : ''}
          </div>
        </div>
        ${renderOverviewSection(dbg, run)}
        ${renderSessionContextSection(request)}
        ${renderBehaviorSection(dbg.behaviorAnalysis)}
        ${renderPipelineStepsSection(dbg.timings)}
        ${renderRagSection(dbg.rag)}
        ${renderSuggestionsSection(dbg.llm?.suggestions)}
        ${renderPromptSection(dbg.prompt)}
        ${renderLlmOutputSection(dbg.llm)}
      </section>`;
  }).join('')}
  `;

  container.querySelectorAll('[data-export-run]').forEach((btn) => {
    const idx = parseInt(btn.dataset.exportRun, 10);
    const { run, payload } = runsData[idx];
    btn.addEventListener('click', () => {
      const exportData = buildLlmExport(run, payload);
      const slug = (run.query || 'run').replace(/[^a-z0-9]+/gi, '-').toLowerCase().substring(0, 40);
      downloadJson(exportData, `arco-llm-export-${slug}.json`);
    });
  });
}

async function renderPage(root, pageId, tab) {
  root.innerHTML = '<p class="admin-loading">Loading page…</p>';
  let data;
  try {
    data = await fetchPage(pageId);
  } catch (err) {
    root.innerHTML = `<p class="admin-error">${esc(err.message)}</p>`;
    return;
  }

  const runs = data.runs || [];
  const initialRun = runs[0]?.run;
  const sessionCrumb = data.sessionId
    ? `<a href="#/sessions/${esc(data.sessionId)}">← Session ${esc(data.sessionId.substring(0, 8))}…</a>`
    : '<a href="#/">← Sessions</a>';

  root.innerHTML = `
    <nav class="admin-crumbs">${sessionCrumb}</nav>
    <div class="admin-toolbar">
      <h2 class="admin-page-title">${esc(initialRun?.query || 'Untitled page')}</h2>
      <div class="admin-badges">
        ${badge(initialRun?.intent_type, intentTone(initialRun?.intent_type))}
        ${badge(`${runs.length} run${runs.length === 1 ? '' : 's'}`, 'accent')}
      </div>
    </div>
    <nav class="admin-tabs">
      <a data-tab="overview" href="#/pages/${esc(pageId)}">Overview</a>
      <a data-tab="reconstruction" href="#/pages/${esc(pageId)}/reconstruction">Full page</a>
      <a data-tab="timeline" href="#/pages/${esc(pageId)}/timeline">Run timeline</a>
      <a data-tab="debug" href="#/pages/${esc(pageId)}/debug">Debug</a>
      <a data-tab="feedback" href="#/pages/${esc(pageId)}/feedback">Feedback</a>
    </nav>
    <div class="admin-tabpanel" id="admin-tabpanel"></div>
  `;

  root.querySelectorAll('.admin-tabs a').forEach((a) => {
    a.classList.toggle('is-active', a.dataset.tab === tab);
  });

  const panel = root.querySelector('#admin-tabpanel');
  if (tab === 'reconstruction') {
    await renderReconstructionTab(panel, data);
  } else if (tab === 'timeline') {
    renderTimelineTab(panel, data);
  } else if (tab === 'debug') {
    renderDebugTab(panel, data);
  } else if (tab === 'feedback') {
    // eslint-disable-next-line no-use-before-define
    await renderFeedbackTab(panel, data);
  } else {
    renderOverviewTab(panel, data);
  }
}

// ── Model catalog helpers (used by LLM Config and Experiments) ───────────────

function renderModelOptions(catalog, selectedKey) {
  const byProvider = catalog.reduce((acc, entry) => {
    (acc[entry.provider] = acc[entry.provider] || []).push(entry);
    return acc;
  }, {});

  return Object.entries(byProvider).map(([provider, entries]) => `
    <optgroup label="${esc(provider)}">
      ${entries.map((e) => {
    const key = `${e.provider}::${e.model}`;
    const disabled = e.available === false;
    const missing = (e.missing || []).join(', ');
    const suffix = disabled ? ` — needs ${missing}` : '';
    return `<option value="${esc(key)}"${disabled ? ' disabled' : ''}${key === selectedKey ? ' selected' : ''}>${esc(e.label)}${esc(suffix)}</option>`;
  }).join('')}
    </optgroup>
  `).join('');
}

function firstAvailableKey(catalog) {
  const first = catalog.find((e) => e.available !== false) || catalog[0];
  return first ? `${first.provider}::${first.model}` : '';
}

function filterModelSelect(searchInput, selectEl, catalog) {
  const q = searchInput.value.toLowerCase().trim();
  const prev = selectEl.value;
  const filtered = q
    ? catalog.filter((e) => e.label.toLowerCase().includes(q) || e.model.toLowerCase().includes(q))
    : catalog;
  const stillAvail = filtered.some((e) => `${e.provider}::${e.model}` === prev);
  selectEl.innerHTML = renderModelOptions(filtered, stillAvail ? prev : '');
  if (!stillAvail) {
    const first = filtered.find((e) => e.available !== false) || filtered[0];
    if (first) selectEl.value = `${first.provider}::${first.model}`;
  } else {
    selectEl.value = prev;
  }
}

// ── LLM Config ──────────────────────────────────────────────────────────────

async function renderLlmConfig(root) {
  root.innerHTML = '<p class="admin-loading">Loading model settings…</p>';
  let catalog;
  let active;
  let limits;
  try {
    const [catRes, cfgRes] = await Promise.all([
      api('/api/admin/catalog'),
      api('/api/admin/llm-config'),
    ]);
    catalog = catRes.catalog || [];
    limits = catRes.limits || {
      temperature: { min: 0, max: 2 },
      maxTokens: { min: 256, max: 16384 },
    };
    active = cfgRes.active || null;
  } catch (err) {
    root.innerHTML = `<p class="admin-error">${esc(err.message)}</p>`;
    return;
  }

  const selected = active || catalog[0] || {};
  const currentKey = `${selected.provider}::${selected.model}`;
  const temperature = active?.temperature ?? 0.6;
  const maxTokens = active?.maxTokens ?? 4096;
  const thinkingVal = typeof active?.thinking === 'boolean' ? active.thinking : null;
  const currentEntry = catalog.find(
    (e) => `${e.provider}::${e.model}` === currentKey,
  );
  const currentMissing = currentEntry?.available === false
    ? (currentEntry.missing || []) : [];

  root.innerHTML = `
    <nav class="admin-crumbs"><a href="#/">← Sessions</a></nav>
    <div class="admin-toolbar">
      <h2>Model Settings</h2>
      <div class="admin-stats">
        <span class="admin-stat"><span class="admin-stat-value">${esc(selected.provider || '—')}</span><span class="admin-stat-label">active provider</span></span>
        <span class="admin-stat"><span class="admin-stat-value">${esc(selected.model || '—')}</span><span class="admin-stat-label">active model</span></span>
      </div>
    </div>

    <section class="admin-card">
      <h3>Active configuration</h3>
      <p class="admin-muted">Applied to the next <code>/api/generate</code> call. Stored in the <code>CACHE</code> KV under <code>llm-config:active</code>.</p>

      <form id="llm-config-form" class="admin-llm-form">
        <label class="admin-field">
          <span>Provider &amp; model</span>
          <input type="search" id="llm-model-search" class="admin-model-search" placeholder="Filter models…" autocomplete="off" aria-label="Filter model list">
          <select name="entry" required>
            ${renderModelOptions(catalog, currentKey)}
          </select>
          ${currentMissing.length
    ? `<small class="admin-llm-warn">Active selection cannot run — missing: ${esc(currentMissing.join(', '))}. Set the secret(s) with <code>wrangler secret put &lt;NAME&gt;</code> and redeploy, or choose a different model.</small>`
    : ''}
        </label>
        <label class="admin-field">
          <span>Temperature <small class="admin-muted">(${limits.temperature.min} – ${limits.temperature.max})</small></span>
          <input type="number" name="temperature" step="0.05" min="${limits.temperature.min}" max="${limits.temperature.max}" value="${temperature}" required>
        </label>
        <label class="admin-field">
          <span>Max tokens <small class="admin-muted">(${limits.maxTokens.min} – ${limits.maxTokens.max})</small></span>
          <input type="number" name="maxTokens" step="64" min="${limits.maxTokens.min}" max="${limits.maxTokens.max}" value="${maxTokens}" required>
        </label>
        <label class="admin-field">
          <span>Reasoning <small class="admin-muted">(Ollama / Cloudflare reasoning models)</small></span>
          <select name="thinking">
            <option value="default"${thinkingVal === null ? ' selected' : ''}>Default (model decides)</option>
            <option value="on"${thinkingVal === true ? ' selected' : ''}>On — enable thinking</option>
            <option value="off"${thinkingVal === false ? ' selected' : ''}>Off — disable thinking (faster)</option>
          </select>
          <small class="admin-muted">Off disables the thinking phase where supported; ignored by models without it.</small>
        </label>
        <div class="admin-llm-actions">
          <button type="submit" class="admin-btn admin-btn-primary">Save</button>
          <span class="admin-llm-status admin-muted" data-status></span>
        </div>
      </form>

      <dl class="admin-kvs admin-kvs-two admin-llm-current">
        ${kv('Updated at', active?.updatedAt || '—')}
        ${kv('Storage key', 'CACHE:llm-config:active')}
      </dl>
    </section>
  `;

  const form = root.querySelector('#llm-config-form');
  const status = root.querySelector('[data-status]');
  const llmSearchInput = root.querySelector('#llm-model-search');
  const llmSelectEl = form.querySelector('select[name="entry"]');
  llmSearchInput.addEventListener('input', () => filterModelSelect(llmSearchInput, llmSelectEl, catalog));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const [provider, model] = String(data.get('entry') || '').split('::');
    const thinkingSel = String(data.get('thinking') || 'default');
    // tri-state: on -> true, off -> false, default -> null
    let thinking = null;
    if (thinkingSel === 'on') thinking = true;
    else if (thinkingSel === 'off') thinking = false;
    const body = {
      provider,
      model,
      temperature: Number(data.get('temperature')),
      maxTokens: Number(data.get('maxTokens')),
      thinking,
    };
    status.textContent = 'Saving…';
    status.classList.remove('is-error', 'is-ok');
    try {
      await api('/api/admin/llm-config', { method: 'PUT', body: JSON.stringify(body) });
      status.textContent = 'Saved.';
      status.classList.add('is-ok');
      await renderLlmConfig(root);
    } catch (err) {
      status.textContent = err.message;
      status.classList.add('is-error');
    }
  });
}

// ── Vectorize: sub-nav ──────────────────────────────────────────────────────

function renderVectorizeSubNav(active) {
  return `
    <nav class="admin-subnav">
      <a href="#/vectorize" data-subnav="overview" class="${active === 'overview' ? 'is-active' : ''}">Overview</a>
      <a href="#/vectorize/search" data-subnav="search" class="${active === 'search' ? 'is-active' : ''}">Search</a>
    </nav>
  `;
}

// ── Vectorize: overview ─────────────────────────────────────────────────────

function renderHistogramBars(title, dist) {
  const entries = Object.entries(dist || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    return `<div class="vec-hist"><h4>${esc(title)}</h4><p class="vec-muted">No values in sample.</p></div>`;
  }
  const max = entries[0][1];
  return `<div class="vec-hist">
    <h4>${esc(title)}</h4>
    <ul class="vec-hist-list">
      ${entries.map(([k, v]) => {
    const pct = max > 0 ? (v / max) * 100 : 0;
    return `<li class="vec-hist-row">
          <span class="vec-hist-label">${esc(k)}</span>
          <span class="vec-hist-bar"><span style="width:${pct.toFixed(1)}%"></span></span>
          <span class="vec-hist-count">${v}</span>
        </li>`;
  }).join('')}
    </ul>
  </div>`;
}

async function renderVectorizeOverview(root) {
  root.innerHTML = `${renderVectorizeSubNav('overview')}<p class="vec-loading">Loading index stats…</p>`;
  let data;
  try {
    data = await api('/api/admin/vectorize/stats?sampleTopK=50');
  } catch (err) {
    root.innerHTML = `${renderVectorizeSubNav('overview')}<p class="vec-error">${esc(err.message)}</p>`;
    return;
  }

  const d = data.describe || {};
  const s = data.sample || {};
  const totalVectors = data.totalVectors ?? d.vectorCount ?? d.vectorsCount ?? null;
  const scoreStats = s.scoreStats || null;
  const lastMutation = d.processedUpToDatetime
    ? new Date(d.processedUpToDatetime).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
    : '—';

  const metric = d.metric ? String(d.metric) : '—';

  root.innerHTML = `
    ${renderVectorizeSubNav('overview')}
    <div class="vec-stats-strip">
      <span class="vec-stat"><span class="vec-stat-value">${fmtInt(totalVectors)}</span><span class="vec-stat-label">vectors (describe)</span></span>
      <span class="vec-stat"><span class="vec-stat-value">${fmtInt(d.dimensions)}</span><span class="vec-stat-label">dimensions</span></span>
      <span class="vec-stat"><span class="vec-stat-value" style="font-size:0.95rem">${esc(metric)}</span><span class="vec-stat-label">metric</span></span>
      <span class="vec-stat"><span class="vec-stat-value" style="font-size:0.95rem">${esc((data.index?.embeddingModel || '').replace(/^@cf\//, ''))}</span><span class="vec-stat-label">model</span></span>
    </div>

    <section class="vec-card">
      <h3>Index metadata</h3>
      <dl class="vec-kvs vec-kvs-two">
        <div class="vec-kv"><dt>Name</dt><dd>${esc(data.index?.name)}</dd></div>
        <div class="vec-kv"><dt>Binding</dt><dd><code>${esc(data.index?.binding)}</code></dd></div>
        <div class="vec-kv"><dt>Embedding model</dt><dd><code>${esc(data.index?.embeddingModel)}</code></dd></div>
        <div class="vec-kv"><dt>Dimensions</dt><dd>${fmtInt(d.dimensions)}</dd></div>
        <div class="vec-kv"><dt>Metric</dt><dd>${esc(metric)}</dd></div>
        <div class="vec-kv"><dt>Total vectors</dt><dd>${fmtInt(totalVectors)}</dd></div>
        <div class="vec-kv"><dt>Processed up to</dt><dd>${esc(lastMutation)}</dd></div>
        <div class="vec-kv"><dt>Last mutation id</dt><dd class="vec-mono">${esc(d.processedUpToMutation || '—')}</dd></div>
      </dl>
      <p class="vec-muted vec-hint">
        Vectorize V2 has no list-all-vectors API, so the breakdown below is sampled from the top
        ${esc(s.topK || 50)} similarity results for a broad seed query
        (<em>${esc(s.seed || '')}</em>). It is a snapshot of the neighbourhood, not a census.
        Max topK is 50 when <code>returnMetadata=all</code> (Vectorize V2 limit).
      </p>
    </section>

    ${s.error ? `<div class="vec-card vec-error-card"><p class="vec-error">Sample failed: ${esc(s.error)}</p></div>` : `
    <section class="vec-card">
      <h3>Sampled type distribution (top ${esc(s.topK || 100)})</h3>
      ${scoreStats ? `<p class="vec-muted vec-hint">
        Score range in sample: ${scoreStats.min.toFixed(3)} – ${scoreStats.max.toFixed(3)}
        · mean ${scoreStats.mean.toFixed(3)} · n=${scoreStats.count}
      </p>` : ''}
      <div class="vec-hist-grid">
        ${renderHistogramBars('type', s.histogram?.type)}
        ${renderHistogramBars('category', s.histogram?.category)}
        ${renderHistogramBars('personaTags', s.histogram?.personaTags)}
        ${renderHistogramBars('difficulty', s.histogram?.difficulty)}
      </div>
    </section>`}

    <section class="vec-card">
      <h3>Next</h3>
      <p>Use <a href="#/vectorize/search">Search</a> to embed a query and retrieve the top-K nearest vectors, or click any item id below to inspect it directly.</p>
    </section>
  `;
}

// ── Vectorize: search ───────────────────────────────────────────────────────

const TYPE_OPTIONS = [
  '', 'guide', 'experience', 'comparison', 'product', 'recipe',
  'hero-image', 'maintenance', 'diagnostic', 'pairing', 'calculator',
];

function readSearchParamsFromHash() {
  const raw = window.location.hash.replace(/^#/, '');
  const [, query = ''] = raw.match(/^\/vectorize\/search\?(.*)$/) || [];
  const p = new URLSearchParams(query);
  return {
    q: p.get('q') || '',
    topK: parseInt(p.get('topK') || '20', 10) || 20,
    type: p.get('type') || '',
    values: p.get('values') === '1',
  };
}

function writeSearchParamsToHash({
  q, topK, type, values,
}) {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (topK && topK !== 20) p.set('topK', String(topK));
  if (type) p.set('type', type);
  if (values) p.set('values', '1');
  const str = p.toString();
  window.location.hash = `/vectorize/search${str ? `?${str}` : ''}`;
}

function renderSearchForm(params) {
  return `
    <section class="vec-card">
      <h3>Query</h3>
      <form class="vec-form" id="vec-search-form">
        <label class="vec-field vec-field-wide">
          <span>Query text</span>
          <input type="text" name="q" value="${esc(params.q)}" placeholder="e.g. quiet espresso machine for a small kitchen" autocomplete="off">
        </label>
        <label class="vec-field">
          <span>top K (1–50)</span>
          <input type="number" name="topK" min="1" max="50" value="${esc(params.topK)}">
        </label>
        <label class="vec-field">
          <span>type filter</span>
          <select name="type">
            ${TYPE_OPTIONS.map((t) => `<option value="${esc(t)}"${t === params.type ? ' selected' : ''}>${t ? esc(t) : '(any)'}</option>`).join('')}
          </select>
        </label>
        <label class="vec-field vec-field-check">
          <input type="checkbox" name="values"${params.values ? ' checked' : ''}>
          <span>include raw vector values</span>
        </label>
        <div class="vec-field vec-field-actions">
          <button type="submit" class="vec-btn vec-btn-accent">Search</button>
        </div>
      </form>
    </section>
  `;
}

function renderMatchRow(match) {
  const md = match.metadata || {};
  const type = md.type || '—';
  const id = match.id || '';
  const scoreFmt = typeof match.score === 'number' ? match.score.toFixed(4) : '—';
  const title = md.title || md.alt || md.sectionHeading || md.name || '';
  const badges = [
    ['type', type],
    ['category', md.category],
    ['difficulty', md.difficulty],
  ].filter(([, v]) => v).map(([k, v]) => `<span class="vec-kvtag"><b>${esc(k)}</b> ${esc(v)}</span>`).join(' ');
  const personaTags = md.personaTags
    ? String(md.personaTags).split(',').filter(Boolean)
      .map((t) => `<span class="vec-kvtag vec-kvtag-soft">persona · ${esc(t.trim())}</span>`)
      .join(' ')
    : '';
  const valuesPreview = (() => {
    if (!Array.isArray(match.values)) return '';
    const head = match.values.slice(0, 8)
      .map((v) => (typeof v === 'number' ? v.toFixed(3) : String(v)))
      .join(', ');
    const more = match.values.length > 8 ? ', …' : '';
    return `[${head}${more}] <span class="vec-muted">(dims=${match.values.length})</span>`;
  })();

  return `
    <li class="vec-result">
      <div class="vec-result-head">
        <span class="vec-score">${esc(scoreFmt)}</span>
        <span class="vec-type-chip vec-type-${esc(type)}">${vecBadge(type, typeTone(type))}</span>
        <a class="vec-result-id vec-mono" href="#/vectorize/items/${encodeURIComponent(id)}">${esc(id)}</a>
      </div>
      ${title ? `<div class="vec-result-title">${esc(title)}</div>` : ''}
      <div class="vec-result-tags">${badges}${personaTags}</div>
      ${valuesPreview ? `<div class="vec-muted vec-result-values">${valuesPreview}</div>` : ''}
      <details class="vec-result-json">
        <summary>metadata JSON</summary>
        <pre>${esc(JSON.stringify(md, null, 2))}</pre>
      </details>
    </li>
  `;
}

async function renderVectorizeSearch(root) {
  const params = readSearchParamsFromHash();
  root.innerHTML = `
    ${renderVectorizeSubNav('search')}
    <div class="vec-search-shell">
      <div class="vec-search-form" id="vec-form-slot">${renderSearchForm(params)}</div>
      <div class="vec-search-results" id="vec-results-slot"></div>
    </div>
  `;

  const form = root.querySelector('#vec-search-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    writeSearchParamsToHash({
      q: fd.get('q') || '',
      topK: parseInt(fd.get('topK') || '20', 10),
      type: fd.get('type') || '',
      values: fd.get('values') === 'on',
    });
  });

  const resultsSlot = root.querySelector('#vec-results-slot');

  if (!params.q) {
    resultsSlot.innerHTML = `
      <section class="vec-card vec-placeholder">
        <h3>Run a search</h3>
        <p class="vec-muted">Enter a query to embed it via <code>@cf/baai/bge-small-en-v1.5</code> and retrieve the top-K nearest vectors from <code>arco-content</code>.</p>
      </section>
    `;
    return;
  }

  resultsSlot.innerHTML = '<p class="vec-loading">Embedding &amp; searching…</p>';

  const qs = new URLSearchParams({ q: params.q, topK: String(params.topK) });
  if (params.type) qs.set('type', params.type);
  if (params.values) qs.set('values', '1');

  let data;
  try {
    data = await api(`/api/admin/vectorize/search?${qs.toString()}`);
  } catch (err) {
    resultsSlot.innerHTML = `<p class="vec-error">${esc(err.message)}</p>`;
    return;
  }

  const t = data.timings || {};
  const preview = (data.embedding?.preview || []).map((v) => (typeof v === 'number' ? v.toFixed(3) : String(v))).join(', ');

  resultsSlot.innerHTML = `
    <section class="vec-card">
      <div class="vec-result-toolbar">
        <div class="vec-result-count">
          <strong>${data.count}</strong> match${data.count === 1 ? '' : 'es'}
          ${params.type ? `<span class="vec-muted">after client-side <code>type=${esc(params.type)}</code> filter (raw topK=${esc(data.totalReturned)})</span>` : ''}
        </div>
        <div class="vec-result-timings vec-muted">
          embed ${vecDur(t.embedMs)} · query ${vecDur(t.queryMs)} · total ${vecDur(t.totalMs)}
          · dims ${esc(data.embedding?.dims || '—')}
        </div>
      </div>
      <details class="vec-result-embed">
        <summary>embedding preview (first 8 dims)</summary>
        <pre>[${esc(preview)}${data.embedding?.dims > 8 ? ', …' : ''}]</pre>
      </details>
      ${data.count === 0
    ? '<p class="vec-empty">No matches for this query.</p>'
    : `<ul class="vec-results">${data.matches.map(renderMatchRow).join('')}</ul>`}
    </section>
  `;
}

// ── Vectorize: item detail ─────────────────────────────────────────────────

async function renderVectorizeItem(root, id) {
  root.innerHTML = `
    <nav class="vec-crumbs"><a href="#/vectorize">← Overview</a> <span>·</span> <a href="#/vectorize/search">Search</a></nav>
    <p class="vec-loading">Loading item <code>${esc(id)}</code>…</p>
  `;

  let data;
  try {
    data = await api(`/api/admin/vectorize/items/${encodeURIComponent(id)}?values=1`);
  } catch (err) {
    root.innerHTML = `
      <nav class="vec-crumbs"><a href="#/vectorize">← Overview</a> <span>·</span> <a href="#/vectorize/search">Search</a></nav>
      <p class="vec-error">${esc(err.message)}</p>
    `;
    return;
  }

  const md = data.metadata || {};
  const valuesPreview = Array.isArray(data.values)
    ? data.values.slice(0, 16).map((v) => (typeof v === 'number' ? v.toFixed(4) : String(v))).join(', ')
    : null;

  root.innerHTML = `
    <nav class="vec-crumbs"><a href="#/vectorize">← Overview</a> <span>·</span> <a href="#/vectorize/search">Search</a></nav>
    <div class="vec-toolbar">
      <h2 class="vec-mono">${esc(data.id)}</h2>
      <div class="vec-badges">
        ${vecBadge(md.type || 'unknown', typeTone(md.type))}
        ${data.dims ? vecBadge(`${data.dims}d`, 'muted') : ''}
      </div>
    </div>

    <section class="vec-card">
      <h3>Metadata</h3>
      <dl class="vec-kvs vec-kvs-two">
        ${Object.entries(md).map(([k, v]) => `<div class="vec-kv"><dt>${esc(k)}</dt><dd>${esc(String(v))}</dd></div>`).join('') || '<p class="vec-muted">No metadata.</p>'}
      </dl>
    </section>

    ${md.url ? `
    <section class="vec-card">
      <h3>Preview</h3>
      <div class="vec-preview-media">
        <a href="${esc(md.url)}" target="_blank" rel="noopener">
          <img src="${esc(md.url)}" alt="${esc(md.alt || '')}" loading="lazy">
        </a>
        ${md.alt ? `<p class="vec-muted">${esc(md.alt)}</p>` : ''}
      </div>
    </section>` : ''}

    ${valuesPreview ? `
    <section class="vec-card">
      <h3>Vector values</h3>
      <p class="vec-muted">First 16 of ${esc(data.dims || data.values.length)} dimensions.</p>
      <pre class="vec-pre">[${esc(valuesPreview)}, …]</pre>
    </section>` : ''}
  `;
}

// ── Experiments ─────────────────────────────────────────────────────────────

const EXPERIMENT_DEFAULTS = { temperature: 0.6, maxTokens: 5120 };
const EXPERIMENT_STATUS_TONE = { complete: 'ok', running: 'warn', error: 'muted' };

async function streamExperimentRun(body, onEvent, signal) {
  const token = getAdminToken();
  if (!token) throw new Error('Admin token required');
  const res = await fetch(`${ARCO_RECOMMENDER_URL}/api/admin/experiments`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`admin:${token}`)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 401) {
    clearAdminToken();
    throw new Error('Unauthorized — token cleared. Reload to retry.');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    // eslint-disable-next-line no-restricted-syntax
    for (const line of lines) {
      if (!line.trim()) continue; // eslint-disable-line no-continue
      try {
        // eslint-disable-next-line no-await-in-loop
        await onEvent(JSON.parse(line));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('Failed to parse experiment event:', err, line);
      }
    }
  }
  if (buffer.trim()) {
    try { await onEvent(JSON.parse(buffer)); } catch { /* ignore */ }
  }
}

function shortModel(provider, model) {
  return `${provider} · ${model}`;
}

function tokensPerSec(outputTokens, durationMs) {
  if (!outputTokens || !durationMs) return null;
  const sec = durationMs / 1000;
  if (sec <= 0) return null;
  return Math.round(outputTokens / sec);
}

async function renderExperimentsList(root) {
  root.innerHTML = '<p class="admin-loading">Loading experiments…</p>';
  let data;
  try {
    data = await api('/api/admin/experiments?limit=100&offset=0');
  } catch (err) {
    root.innerHTML = `<p class="admin-error">${esc(err.message)}</p>`;
    return;
  }

  const experiments = data.experiments || [];
  const total = data.total || 0;

  root.innerHTML = `
    <div class="admin-toolbar">
      <h2>Experiments</h2>
      <div class="admin-header-actions">
        <a class="admin-btn admin-btn-primary" href="#/experiments/new">+ New experiment</a>
      </div>
    </div>
    <p class="admin-muted admin-experiments-hint">
      Run the same query against multiple LLMs in parallel — the upstream
      pipeline (intent + RAG + prompt) executes once, then each variant
      fans out on the final LLM call. Compare tokens, duration, and
      generated output side-by-side.
    </p>
    <div class="admin-stats">
      <span class="admin-stat"><span class="admin-stat-value">${total}</span><span class="admin-stat-label">total</span></span>
    </div>
    ${experiments.length === 0
    ? '<p class="admin-empty">No experiments yet. Click <strong>New experiment</strong> to run one.</p>'
    : `<div class="admin-table-wrap"><table class="admin-table admin-experiments-table">
        <thead><tr>
          <th>Query</th><th>Variants</th><th>Status</th>
          <th>Intent</th><th>Upstream</th><th>Created</th>
        </tr></thead>
        <tbody>${experiments.map((e) => {
    const status = e.status || 'running';
    const tone = EXPERIMENT_STATUS_TONE[status] || 'muted';
    const completeCount = e.complete_count ?? 0;
    return `<tr data-href="#/experiments/${esc(e.id)}">
      <td class="admin-query">${esc(e.query || '')}</td>
      <td>${badge(`${completeCount} / ${e.variant_count}`, completeCount === e.variant_count ? 'accent' : 'warn')}</td>
      <td>${badge(status, tone)}</td>
      <td>${badge(e.shared_intent_type || '—', intentTone(e.shared_intent_type))}</td>
      <td class="admin-muted">${dur(e.shared_duration_ms)}</td>
      <td class="admin-muted">${ts(e.created_at)}</td>
    </tr>`;
  }).join('')}
        </tbody>
      </table></div>`}
  `;

  root.querySelectorAll('tr[data-href]').forEach((tr) => {
    tr.addEventListener('click', () => { navigate(tr.dataset.href); });
  });
}

function prefillQueryFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('q') || params.get('query') || '';
  } catch {
    return '';
  }
}

const MAX_EXPERIMENT_VARIANTS = 12;

function renderVariantRow(catalog, preset = {}) {
  const selectedKey = preset.key || firstAvailableKey(catalog);
  const temperature = preset.temperature ?? EXPERIMENT_DEFAULTS.temperature;
  const maxTokens = preset.maxTokens ?? EXPERIMENT_DEFAULTS.maxTokens;
  return `
    <div class="admin-experiment-variant-row" data-variant-row>
      <span class="admin-experiment-variant-index" data-role="index">#1</span>
      <label class="admin-experiment-variant-field admin-experiment-variant-model">
        <span>Model</span>
        <input type="search" class="admin-model-search" placeholder="Filter models…" autocomplete="off" aria-label="Filter model list">
        <select name="model" required>
          ${renderModelOptions(catalog, selectedKey)}
        </select>
      </label>
      <label class="admin-experiment-variant-field">
        <span>Temp</span>
        <input type="number" name="temperature" step="0.05" min="0" max="2" value="${esc(temperature)}" required>
      </label>
      <label class="admin-experiment-variant-field">
        <span>Max tok</span>
        <input type="number" name="maxTokens" step="64" min="256" max="16384" value="${esc(maxTokens)}" required>
      </label>
      <div class="admin-experiment-variant-actions">
        <button type="button" class="admin-experiment-variant-btn" data-action="dup" aria-label="Duplicate this variant" title="Duplicate this variant">Duplicate</button>
        <button type="button" class="admin-experiment-variant-btn admin-experiment-variant-btn-remove" data-action="remove" aria-label="Remove this variant" title="Remove this variant">Remove</button>
      </div>
    </div>
  `;
}

function collectVariantsFromForm(form) {
  const variants = [];
  form.querySelectorAll('[data-variant-row]').forEach((row) => {
    const select = row.querySelector('select[name="model"]');
    const [provider, ...modelParts] = (select.value || '').split('::');
    const model = modelParts.join('::');
    if (!provider || !model) return;
    const temperature = parseFloat(row.querySelector('input[name="temperature"]').value);
    const maxTokens = parseInt(row.querySelector('input[name="maxTokens"]').value, 10);
    const label = select.selectedOptions[0]?.textContent?.replace(/\s+—\s+needs.*$/, '')?.trim() || `${provider} · ${model}`;
    variants.push({
      provider,
      model,
      label,
      temperature: Number.isNaN(temperature) ? null : temperature,
      maxTokens: Number.isNaN(maxTokens) ? null : maxTokens,
    });
  });
  return variants;
}

function variantProgressCard(variant) {
  return `
    <article class="admin-experiment-card" data-variant-id="${esc(variant.variantId)}">
      <header class="admin-experiment-card-head">
        <span class="admin-experiment-card-label">${esc(variant.label || shortModel(variant.provider, variant.model))}</span>
        <span class="admin-experiment-card-status" data-role="status">queued</span>
      </header>
      <div class="admin-experiment-card-body">
        <dl class="admin-kvs">
          <div class="admin-kv"><dt>temp</dt><dd>${variant.temperature ?? '—'}</dd></div>
          <div class="admin-kv"><dt>max tok</dt><dd>${variant.maxTokens ?? '—'}</dd></div>
          <div class="admin-kv"><dt>sections</dt><dd data-role="sections">0</dd></div>
          <div class="admin-kv"><dt>duration</dt><dd data-role="duration">—</dd></div>
          <div class="admin-kv"><dt>TTFT</dt><dd data-role="ttft">—</dd></div>
          <div class="admin-kv"><dt>tokens in / out</dt><dd data-role="tokens">—</dd></div>
        </dl>
        <p class="admin-experiment-card-note" data-role="note"></p>
      </div>
    </article>
  `;
}

async function renderExperimentCreateForm(root) {
  root.innerHTML = '<p class="admin-loading">Loading model catalog…</p>';
  let catRes;
  try {
    catRes = await api('/api/admin/catalog');
  } catch (err) {
    root.innerHTML = `<p class="admin-error">${esc(err.message)}</p>`;
    return;
  }
  const catalog = catRes.catalog || [];
  const prefill = prefillQueryFromUrl();

  root.innerHTML = `
    <nav class="admin-crumbs"><a href="#/experiments">← Experiments</a></nav>
    <div class="admin-toolbar">
      <h2>New experiment</h2>
    </div>

    <section class="admin-card">
      <h3>1. Query</h3>
      <p class="admin-muted">Same format as the <code>?q=</code> parameter on the site.</p>
      <form id="admin-experiment-form" class="admin-experiment-form">
        <label class="admin-field admin-field-wide">
          <span>Query</span>
          <input type="text" name="query" value="${esc(prefill)}"
            placeholder="e.g. best espresso machine under 1000"
            autocomplete="off" required maxlength="500">
        </label>

        <h3>2. Variants</h3>
        <p class="admin-muted">Up to ${MAX_EXPERIMENT_VARIANTS} rows. Pick a model, set temperature and max_tokens. Add the same model multiple times with different settings to sweep a parameter.</p>
        <div class="admin-experiment-variants" data-role="variants">
          ${renderVariantRow(catalog)}
        </div>
        <div class="admin-experiment-variant-footer">
          <button type="button" class="admin-btn admin-btn-ghost" data-role="add-variant">+ Add variant</button>
          <button type="button" class="admin-btn admin-btn-ghost" data-role="sweep-temp" title="Duplicate the last row three times at 0.3 / 0.6 / 0.9">Temp sweep</button>
        </div>

        <div class="admin-experiment-actions">
          <button type="submit" class="admin-btn admin-btn-primary" data-role="run">Run experiment</button>
          <button type="button" class="admin-btn admin-btn-ghost" data-role="cancel" hidden>Cancel</button>
          <span class="admin-experiment-summary admin-muted" data-role="summary">1 variant</span>
        </div>
      </form>
    </section>

    <section class="admin-card admin-experiment-progress" hidden data-role="progress-card">
      <h3>Progress</h3>
      <div class="admin-experiment-progress-meta">
        <span data-role="progress-phase">Waiting…</span>
        <span class="admin-muted" data-role="progress-ids"></span>
      </div>
      <div class="admin-experiment-progress-action" data-role="progress-action"></div>
      <div class="admin-experiment-cards" data-role="cards"></div>
    </section>
  `;

  const form = root.querySelector('#admin-experiment-form');
  const summaryEl = form.querySelector('[data-role="summary"]');
  const runBtn = form.querySelector('[data-role="run"]');
  const cancelBtn = form.querySelector('[data-role="cancel"]');
  const variantsContainer = form.querySelector('[data-role="variants"]');
  const addBtn = form.querySelector('[data-role="add-variant"]');
  const sweepBtn = form.querySelector('[data-role="sweep-temp"]');
  const progressCard = root.querySelector('[data-role="progress-card"]');
  const progressPhase = root.querySelector('[data-role="progress-phase"]');
  const progressIds = root.querySelector('[data-role="progress-ids"]');
  const progressAction = root.querySelector('[data-role="progress-action"]');
  const cardsContainer = root.querySelector('[data-role="cards"]');

  const rowNodes = () => [...variantsContainer.querySelectorAll('[data-variant-row]')];

  const refreshSummary = () => {
    const rows = rowNodes();
    rows.forEach((row, i) => {
      row.querySelector('[data-role="index"]').textContent = `#${i + 1}`;
      const removeBtn = row.querySelector('[data-action="remove"]');
      if (removeBtn) removeBtn.disabled = rows.length === 1;
    });
    const atMax = rows.length >= MAX_EXPERIMENT_VARIANTS;
    addBtn.disabled = atMax;
    sweepBtn.disabled = atMax;
    summaryEl.textContent = rows.length === 1
      ? '1 variant'
      : `${rows.length} variants · running in parallel`;
  };

  const appendRow = (preset) => {
    if (rowNodes().length >= MAX_EXPERIMENT_VARIANTS) return null;
    variantsContainer.insertAdjacentHTML('beforeend', renderVariantRow(catalog, preset));
    refreshSummary();
    return variantsContainer.lastElementChild;
  };

  const duplicateRow = (row) => {
    if (rowNodes().length >= MAX_EXPERIMENT_VARIANTS) return;
    const select = row.querySelector('select[name="model"]');
    const temp = row.querySelector('input[name="temperature"]').value;
    const maxTok = row.querySelector('input[name="maxTokens"]').value;
    const clone = document.createElement('div');
    clone.innerHTML = renderVariantRow(catalog, {
      key: select.value,
      temperature: temp,
      maxTokens: maxTok,
    }).trim();
    row.insertAdjacentElement('afterend', clone.firstElementChild);
    refreshSummary();
  };

  variantsContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const row = btn.closest('[data-variant-row]');
    if (!row) return;
    if (btn.dataset.action === 'remove') {
      if (rowNodes().length > 1) row.remove();
      refreshSummary();
    } else if (btn.dataset.action === 'dup') {
      duplicateRow(row);
    }
  });

  variantsContainer.addEventListener('change', refreshSummary);
  variantsContainer.addEventListener('input', (e) => {
    if (e.target.classList.contains('admin-model-search')) {
      const row = e.target.closest('[data-variant-row]');
      if (row) filterModelSelect(e.target, row.querySelector('select[name="model"]'), catalog);
    }
    refreshSummary();
  });

  addBtn.addEventListener('click', () => {
    const last = rowNodes().at(-1);
    if (last) {
      duplicateRow(last);
    } else {
      appendRow();
    }
  });

  sweepBtn.addEventListener('click', () => {
    const last = rowNodes().at(-1);
    if (!last) return;
    const select = last.querySelector('select[name="model"]');
    const maxTok = last.querySelector('input[name="maxTokens"]').value;
    const key = select.value;
    // Seed the last row at 0.3 if it isn't already; then add 0.6 and 0.9.
    last.querySelector('input[name="temperature"]').value = '0.3';
    [0.6, 0.9].forEach((t) => {
      if (rowNodes().length < MAX_EXPERIMENT_VARIANTS) {
        appendRow({ key, temperature: t, maxTokens: maxTok });
      }
    });
    refreshSummary();
  });

  let abortController = null;

  cancelBtn.addEventListener('click', () => {
    if (abortController) abortController.abort();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = form.querySelector('input[name="query"]').value.trim();
    const variants = collectVariantsFromForm(form);
    if (!query) { summaryEl.textContent = 'Query is required.'; return; }
    if (variants.length === 0) { summaryEl.textContent = 'Select at least one variant.'; return; }
    if (variants.length > MAX_EXPERIMENT_VARIANTS) { summaryEl.textContent = `Max ${MAX_EXPERIMENT_VARIANTS} variants.`; return; }

    runBtn.disabled = true;
    cancelBtn.hidden = false;
    progressCard.hidden = false;
    cardsContainer.innerHTML = '';
    progressPhase.textContent = 'Starting…';
    progressIds.textContent = '';
    progressAction.innerHTML = '';

    abortController = new AbortController();
    let experimentId = null;
    try {
      await streamExperimentRun({ query, variants }, (evt) => {
        if (evt.type === 'experiment-start') {
          experimentId = evt.experimentId;
          progressIds.textContent = `experiment ${experimentId.substring(0, 8)}… · ${evt.variantCount} variants`;
          cardsContainer.innerHTML = (evt.variants || []).map(variantProgressCard).join('');
        } else if (evt.type === 'upstream-done') {
          progressPhase.textContent = `Upstream complete (${dur(evt.sharedDurationMs)}) · intent ${evt.intentType || '—'} · fanning out to LLMs…`;
        } else if (evt.type === 'variant-start') {
          const card = cardsContainer.querySelector(`[data-variant-id="${CSS.escape(evt.variantId)}"]`);
          if (card) {
            card.dataset.status = 'running';
            card.querySelector('[data-role="status"]').textContent = 'streaming…';
          }
        } else if (evt.type === 'section' && evt.variantId) {
          const card = cardsContainer.querySelector(`[data-variant-id="${CSS.escape(evt.variantId)}"]`);
          if (card) {
            const sectionsEl = card.querySelector('[data-role="sections"]');
            sectionsEl.textContent = String(Number(sectionsEl.textContent || '0') + 1);
          }
        } else if (evt.type === 'variant-done') {
          const card = cardsContainer.querySelector(`[data-variant-id="${CSS.escape(evt.variantId)}"]`);
          if (card) {
            card.dataset.status = 'complete';
            card.querySelector('[data-role="status"]').textContent = 'complete';
            card.querySelector('[data-role="duration"]').textContent = dur(evt.durationMs);
            card.querySelector('[data-role="ttft"]').textContent = evt.ttftMs != null ? dur(evt.ttftMs) : '—';
            card.querySelector('[data-role="tokens"]').textContent = evt.inputTokens != null
              ? `${evt.inputTokens}↑ ${evt.outputTokens}↓`
              : '—';
            if (evt.title) card.querySelector('[data-role="note"]').textContent = evt.title;
          }
        } else if (evt.type === 'variant-error') {
          const card = cardsContainer.querySelector(`[data-variant-id="${CSS.escape(evt.variantId)}"]`);
          if (card) {
            card.dataset.status = 'error';
            card.querySelector('[data-role="status"]').textContent = 'error';
            card.querySelector('[data-role="note"]').textContent = evt.message || 'variant failed';
          }
        } else if (evt.type === 'experiment-done') {
          const hasErrors = evt.completedCount < evt.variantCount;
          progressPhase.textContent = hasErrors
            ? `Done — ${evt.completedCount} / ${evt.variantCount} completed, ${evt.variantCount - evt.completedCount} failed`
            : `Done (${evt.completedCount} / ${evt.variantCount} complete)`;
          if (hasErrors) {
            progressAction.innerHTML = '<button type="button" class="admin-btn" data-action="view-results">View results</button>';
            progressAction.querySelector('[data-action="view-results"]').addEventListener('click', () => {
              if (experimentId) navigate(`#/experiments/${experimentId}`);
            });
          } else {
            setTimeout(() => {
              if (experimentId) navigate(`#/experiments/${experimentId}`);
            }, 1500);
          }
        } else if (evt.type === 'error') {
          progressPhase.textContent = `Error: ${evt.message || 'unknown'}`;
        }
      }, abortController.signal);
    } catch (err) {
      if (err.name === 'AbortError') {
        progressPhase.textContent = 'Cancelled.';
      } else {
        progressPhase.textContent = `Error: ${err.message}`;
      }
    } finally {
      runBtn.disabled = false;
      cancelBtn.hidden = true;
      abortController = null;
    }
  });

  refreshSummary();
}

function renderExperimentOverviewTable(experiment, variants) {
  const rows = variants.map((v, i) => {
    const tps = tokensPerSec(v.output_tokens, v.duration_ms);
    const statusTone = EXPERIMENT_STATUS_TONE[v.status] || 'muted';
    return `<tr data-variant-id="${esc(v.id)}" data-variant-index="${i}">
      <td class="admin-muted">${i}</td>
      <td>${esc(v.provider)}</td>
      <td class="admin-mono">${esc(v.model)}</td>
      <td>${v.temperature ?? '—'}</td>
      <td>${v.max_tokens ?? '—'}</td>
      <td>${badge(v.status || '—', statusTone)}</td>
      <td>${dur(v.duration_ms)}</td>
      <td>${v.time_to_first_token_ms != null ? dur(v.time_to_first_token_ms) : '—'}</td>
      <td>${v.input_tokens != null ? v.input_tokens : '—'}</td>
      <td>${v.output_tokens != null ? v.output_tokens : '—'}</td>
      <td class="admin-muted">${tps ? `${tps}/s` : '—'}</td>
      <td class="admin-muted">${v.status === 'error' && v.error ? `<span class="admin-error-text">${esc(v.error.substring(0, 120))}</span>` : esc((v.title || '').substring(0, 60))}</td>
    </tr>`;
  }).join('');

  return `<div class="admin-table-wrap"><table class="admin-table admin-experiment-variants-table">
    <thead><tr>
      <th>#</th><th>Provider</th><th>Model</th>
      <th>Temp</th><th>Max tok</th>
      <th>Status</th><th>Duration</th><th>TTFT</th>
      <th>In tok</th><th>Out tok</th><th>Throughput</th>
      <th>Title</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderExperimentPills(variants, activeId) {
  if (!variants.length) return '';
  return `<nav class="admin-experiment-pills">
    ${variants.map((v, i) => `
      <button type="button" class="admin-experiment-pill${v.id === activeId ? ' is-active' : ''}"
        data-variant-id="${esc(v.id)}" data-variant-index="${i}">
        <span class="admin-experiment-pill-index">#${i}</span>
        <span class="admin-experiment-pill-model">${esc(v.provider)} · ${esc(v.model)}</span>
        <span class="admin-experiment-pill-meta">${v.status === 'complete' ? dur(v.duration_ms) : esc(v.status || '—')}</span>
      </button>`).join('')}
  </nav>`;
}

async function renderExperimentVariantPreview(container, experimentId, variantId, cache) {
  container.innerHTML = '<p class="admin-loading">Loading variant…</p>';
  let entry = cache.get(variantId);
  if (!entry) {
    try {
      const data = await api(`/api/admin/experiments/${experimentId}/variants/${variantId}`);
      entry = data;
      cache.set(variantId, entry);
    } catch (err) {
      container.innerHTML = `<p class="admin-error">${esc(err.message)}</p>`;
      return;
    }
  }
  const { payload } = entry;
  const { variant } = entry;
  container.innerHTML = '';

  if (variant?.status === 'error') {
    container.innerHTML = `<p class="admin-error">This variant failed: ${esc(variant.error || 'unknown error')}</p>`;
    return;
  }

  if (!payload?.blocks?.length) {
    container.innerHTML = '<p class="admin-empty">No blocks stored for this variant.</p>';
    return;
  }

  const stage = document.createElement('div');
  stage.className = 'admin-preview-stage admin-experiment-preview';
  const main = document.createElement('main');
  main.className = 'admin-preview-main';
  stage.appendChild(main);
  container.appendChild(stage);

  // eslint-disable-next-line no-restricted-syntax
  for (const blockData of payload.blocks) {
    // eslint-disable-next-line no-await-in-loop
    await renderStoredSection(blockData, main);
  }
}

async function renderExperiment(root, experimentId, activeVariantId) {
  root.innerHTML = '<p class="admin-loading">Loading experiment…</p>';
  let data;
  try {
    data = await api(`/api/admin/experiments/${experimentId}`);
  } catch (err) {
    root.innerHTML = `<p class="admin-error">${esc(err.message)}</p>`;
    return;
  }

  const { experiment } = data;
  const variants = data.variants || [];
  const active = activeVariantId && variants.find((v) => v.id === activeVariantId)
    ? activeVariantId
    : (variants[0]?.id || null);

  const totalOut = variants.reduce((n, v) => n + (v.output_tokens || 0), 0);
  const totalIn = variants.reduce((n, v) => n + (v.input_tokens || 0), 0);
  const fastest = variants
    .filter((v) => v.status === 'complete' && v.duration_ms)
    .sort((a, b) => a.duration_ms - b.duration_ms)[0];

  root.innerHTML = `
    <nav class="admin-crumbs"><a href="#/experiments">← Experiments</a></nav>
    <div class="admin-toolbar">
      <h2 class="admin-page-title">${esc(experiment.query || 'Untitled experiment')}</h2>
      <div class="admin-badges">
        ${badge(experiment.status || '—', EXPERIMENT_STATUS_TONE[experiment.status] || 'muted')}
        ${badge(experiment.shared_intent_type || '—', intentTone(experiment.shared_intent_type))}
        ${badge(`${variants.length} variants`, 'accent')}
      </div>
    </div>

    <div class="admin-stats admin-stats-strip">
      <span class="admin-stat"><span class="admin-stat-value">${dur(experiment.shared_duration_ms)}</span><span class="admin-stat-label">upstream</span></span>
      <span class="admin-stat"><span class="admin-stat-value">${fastest ? dur(fastest.duration_ms) : '—'}</span><span class="admin-stat-label">fastest variant</span></span>
      <span class="admin-stat"><span class="admin-stat-value">${totalIn}</span><span class="admin-stat-label">tokens in (sum)</span></span>
      <span class="admin-stat"><span class="admin-stat-value">${totalOut}</span><span class="admin-stat-label">tokens out (sum)</span></span>
      <span class="admin-stat"><span class="admin-stat-value">${ts(experiment.created_at)}</span><span class="admin-stat-label">created</span></span>
    </div>

    <section class="admin-card">
      <h3>Variant overview</h3>
      ${variants.length === 0
    ? '<p class="admin-empty">No variants recorded.</p>'
    : renderExperimentOverviewTable(experiment, variants)}
    </section>

    <section class="admin-card admin-experiment-flipthrough">
      <h3>Flip through results</h3>
      ${renderExperimentPills(variants, active)}
      <div class="admin-experiment-preview-slot" data-role="preview"></div>
    </section>
  `;

  const previewSlot = root.querySelector('[data-role="preview"]');
  const cache = new Map();

  const activate = async (variantId) => {
    root.querySelectorAll('.admin-experiment-pill').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.variantId === variantId);
    });
    await renderExperimentVariantPreview(previewSlot, experimentId, variantId, cache);
    // Shallow URL update for deep-linking; don't fire another render.
    const nextHash = `#/experiments/${experimentId}/variants/${variantId}`;
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, '', nextHash);
    }
  };

  root.querySelectorAll('.admin-experiment-pill').forEach((btn) => {
    btn.addEventListener('click', () => activate(btn.dataset.variantId));
  });
  root.querySelectorAll('tr[data-variant-id]').forEach((tr) => {
    tr.addEventListener('click', () => activate(tr.dataset.variantId));
  });

  if (active) await activate(active);
  else previewSlot.innerHTML = '<p class="admin-empty">No variants to preview.</p>';
}

// ── LLM Evaluation ──────────────────────────────────────────────────────────

const EVAL_STATUS_TONE = { complete: 'ok', running: 'warn', error: 'muted' };
const QUALITY_TONE = (score) => {
  if (score == null) return 'muted';
  if (score >= 4) return 'ok';
  if (score >= 3) return 'warn';
  return 'muted';
};

// Pairwise significance hint — flags model pairs whose 95% CIs overlap so the
// reader doesn't over-interpret a tiny composite-score gap. Sorts by quality
// descending; reports any pair where |meanA - meanB| <= ci95A + ci95B.
function renderSignificanceHint(perModel) {
  const ranked = perModel
    .filter((m) => m.avgQuality != null && m.qualityCi95 != null && m.qualityN >= 2)
    .slice()
    .sort((a, b) => b.avgQuality - a.avgQuality);
  if (ranked.length < 2) return '';
  const overlaps = [];
  for (let i = 0; i < ranked.length - 1; i += 1) {
    const a = ranked[i];
    const b = ranked[i + 1];
    const delta = Math.abs(a.avgQuality - b.avgQuality);
    const margin = (a.qualityCi95 || 0) + (b.qualityCi95 || 0);
    if (delta <= margin) {
      overlaps.push(`${esc(a.label)} vs ${esc(b.label)}: Δ=${delta.toFixed(2)}, CIs overlap (±${margin.toFixed(2)})`);
    }
  }
  if (!overlaps.length) {
    return '<p class="admin-muted admin-eval-significance">All pairwise composite gaps exceed the combined 95% CIs — rankings are statistically distinguishable.</p>';
  }
  return `<p class="admin-muted admin-eval-significance"><strong>Within noise:</strong> ${overlaps.join(' · ')}. Treat these as ties — increase suite size or judge passes per cell to separate them.</p>`;
}

const QUALITY_RUBRIC_HTML = `
  <details class="admin-eval-rubric">
    <summary>How is quality scored?</summary>
    <div class="admin-eval-rubric-body">
      <p>Claude grades each generation on seven dimensions, each <strong>1–5</strong>
        (1 = poor, 5 = excellent). The cell score is the unweighted mean — so the
        composite ranges from <strong>1.00 (worst)</strong> to <strong>5.00 (best)</strong>.</p>
      <ul class="admin-eval-rubric-list">
        <li><strong>Structure</strong> — well-formed EDS blocks, required sections present, no malformed HTML.</li>
        <li><strong>Intent</strong> — does the page actually answer the query and match the classified intent?</li>
        <li><strong>Faithfulness</strong> — products, prices, and specs grounded in the RAG context (no hallucinated SKUs or prices).</li>
        <li><strong>Helpfulness</strong> — editorial polish, tone, hierarchy, useful next steps.</li>
        <li><strong>Brand voice</strong> — sounds like a knowledgeable, approachable specialty-coffee brand. Penalizes generic AI filler and clichés.</li>
        <li><strong>Specificity</strong> — concrete coffee details (grams, ratios, temps, grind sizes, named techniques) instead of vague generalities.</li>
        <li><strong>Visual / asset usage</strong> — hero present, product / story / experience tokens placed where they aid the reader, no missing assets.</li>
      </ul>
      <p class="admin-eval-rubric-legend">
        Color guide:
        <span class="admin-badge admin-badge-ok">≥ 4.00 strong</span>
        <span class="admin-badge admin-badge-warn">3.00 – 3.99 mixed</span>
        <span class="admin-badge admin-badge-muted">&lt; 3.00 weak</span>
      </p>
      <p class="admin-muted">
        The compact <code>4·5·3·4·5·3·4</code> notation under each cell shows the raw per-dimension scores
        in order: structure · intent · faithfulness · helpfulness · brand voice · specificity · visual.
      </p>
      <p class="admin-muted">
        <strong>Blocker tag:</strong> cells whose <em>faithfulness</em> or <em>structure</em> scores below 3,
        or whose deterministic assertions fail (broken tokens, unbalanced HTML, off-topic decline expected),
        get a <span class="admin-eval-cell-blocker">⚠ blocker</span> badge. The score itself is the raw judge
        composite — the badge is a quality flag, not a score modifier. The per-model summary reports a
        <em>Blocker rate</em> so a high cell average doesn't mask a high rate of unshippable generations.
      </p>
    </div>
  </details>
`;

async function renderEvaluationsList(root) {
  root.innerHTML = '<p class="admin-loading">Loading evaluations…</p>';
  let data;
  let queueData = null;
  try {
    [data, queueData] = await Promise.all([
      api('/api/admin/evaluations?limit=100&offset=0'),
      api('/api/admin/eval-queue').catch(() => null),
    ]);
  } catch (err) {
    root.innerHTML = `<p class="admin-error">${esc(err.message)}</p>`;
    return;
  }

  const runs = data.runs || [];
  const total = data.total || 0;
  const queueTotal = queueData?.total || 0;

  const queueHtml = queueTotal > 0
    ? `<span class="admin-stat"><span class="admin-stat-value">${queueTotal}</span><span class="admin-stat-label">queued</span></span>
       <span class="admin-stat"><span class="admin-stat-value">${queueData.pendingGenerate || 0}</span><span class="admin-stat-label">gen</span></span>
       <span class="admin-stat"><span class="admin-stat-value">${queueData.pendingJudge || 0}</span><span class="admin-stat-label">judge</span></span>
       ${queueData.pendingRetries ? `<span class="admin-stat"><span class="admin-stat-value">${queueData.pendingRetries}</span><span class="admin-stat-label">retries</span></span>` : ''}
       <button type="button" class="admin-btn admin-btn-ghost admin-btn-sm" data-role="purge-queue">Purge queue</button>`
    : '<span class="admin-stat"><span class="admin-stat-value">0</span><span class="admin-stat-label">queued</span></span>';

  root.innerHTML = `
    <div class="admin-toolbar">
      <h2>LLM Evaluation</h2>
      <div class="admin-header-actions">
        <a class="admin-btn admin-btn-primary" href="#/evaluations/new">+ New evaluation</a>
      </div>
    </div>
    <p class="admin-muted admin-experiments-hint">
      Run a fixed coffee query suite across multiple LLMs and let Claude score each
      generation on seven dimensions: structure, intent alignment, RAG faithfulness,
      helpfulness, brand voice, specificity, and visual / asset usage. Speed metrics
      (TTFT, total duration, tokens/sec) come for free from each run.
    </p>
    <div class="admin-stats">
      <span class="admin-stat"><span class="admin-stat-value">${total}</span><span class="admin-stat-label">runs</span></span>
      ${queueHtml}
    </div>
    ${runs.length === 0
    ? '<p class="admin-empty">No evaluations yet. Click <strong>New evaluation</strong> to run one.</p>'
    : `<div class="admin-table-wrap"><table class="admin-table admin-eval-runs-table">
        <thead><tr>
          <th>Suite</th><th>Models</th><th>Status</th>
          <th>Queries</th><th>Quality</th><th>Cost est.</th><th>Created</th>
        </tr></thead>
        <tbody>${runs.map((r) => {
    const phase = r.phase || null;
    const statusLabel = (phase === 'generating' || phase === 'judging')
      ? `${phase} ${r.completed_queries || 0}/${r.query_count}`
      : (r.status || 'running');
    const tone = EVAL_STATUS_TONE[r.status || 'running'] || 'muted';
    let avgQuality = null;
    try {
      const summary = r.summary_json ? JSON.parse(r.summary_json) : null;
      if (summary?.perModel?.length) {
        const scores = summary.perModel.map((m) => m.avgQuality).filter((s) => s != null);
        if (scores.length) {
          avgQuality = Math.round(
            (scores.reduce((a, b) => a + b, 0) / scores.length) * 100,
          ) / 100;
        }
      }
    } catch { /* ignore */ }
    return `<tr data-href="#/evaluations/${esc(r.id)}">
      <td>${esc(r.suite_name || r.suite_id)}</td>
      <td>${badge(`${r.model_count}`, 'accent')} <span class="admin-muted">· ${r.variant_count} runs</span></td>
      <td>${badge(statusLabel, tone)}</td>
      <td>${r.query_count}</td>
      <td>${avgQuality != null ? `<span class="admin-badge admin-badge-${QUALITY_TONE(avgQuality)}">${avgQuality.toFixed(2)}</span>` : '<span class="admin-muted">—</span>'}</td>
      <td class="admin-muted">${r.estimated_cost_usd != null ? `$${r.estimated_cost_usd.toFixed(2)}` : '—'}</td>
      <td class="admin-muted">${ts(r.created_at)}</td>
    </tr>`;
  }).join('')}
        </tbody>
      </table></div>`}
  `;

  root.querySelectorAll('tr[data-href]').forEach((tr) => {
    tr.addEventListener('click', () => { navigate(tr.dataset.href); });
  });

  const purgeBtn = root.querySelector('[data-role="purge-queue"]');
  if (purgeBtn) {
    purgeBtn.addEventListener('click', async () => {
      if (!window.confirm('Purge all pending queue messages? Active runs will be marked as errored.')) return;
      purgeBtn.disabled = true;
      purgeBtn.textContent = 'Purging…';
      try {
        await api('/api/admin/eval-queue/purge', { method: 'POST' });
        await renderEvaluationsList(root);
      } catch (err) {
        purgeBtn.textContent = `Error: ${err.message}`;
        purgeBtn.disabled = false;
      }
    });
  }
}

const MAX_EVAL_MODELS = 8;

const EVAL_MODEL_PRESETS = [
  {
    id: 'cerebras',
    label: 'Cerebras only',
    description: '3 Cerebras models — fast chip inference',
    models: [
      { key: 'cerebras::gpt-oss-120b', temperature: 0.6, maxTokens: 5120 },
      { key: 'cerebras::llama3.1-8b', temperature: 0.6, maxTokens: 5120 },
      { key: 'cerebras::qwen-3-235b-a22b-instruct-2507', temperature: 0.6, maxTokens: 5120 },
    ],
  },
  {
    id: 'gpt-oss',
    label: 'GPT-OSS providers',
    description: 'GPT-OSS 120B on every provider that carries it',
    models: [
      { key: 'cerebras::gpt-oss-120b', temperature: 0.6, maxTokens: 5120 },
      { key: 'cloudflare::@cf/openai/gpt-oss-120b', temperature: 0.6, maxTokens: 5120 },
      { key: 'sambanova::gpt-oss-120b', temperature: 0.6, maxTokens: 5120 },
    ],
  },
  {
    id: 'diverse',
    label: 'Diverse mix',
    description: '6 models across Cerebras, Cloudflare and Bedrock',
    models: [
      { key: 'cerebras::gpt-oss-120b', temperature: 0.6, maxTokens: 5120 },
      { key: 'cloudflare::@cf/meta/llama-3.3-70b-instruct-fp8-fast', temperature: 0.6, maxTokens: 5120 },
      { key: 'cloudflare::anthropic/claude-sonnet-4.6', temperature: 0.6, maxTokens: 5120 },
      { key: 'cloudflare::@cf/moonshotai/kimi-k2.6', temperature: 0.6, maxTokens: 5120 },
      { key: 'bedrock::deepseek.v3.2', temperature: 0.6, maxTokens: 5120 },
      { key: 'bedrock::us.anthropic.claude-sonnet-4-20250514-v1:0', temperature: 0.6, maxTokens: 5120 },
    ],
  },
  {
    id: 'distinct-families',
    label: 'Distinct families',
    description: '8 different model families across Cerebras, Cloudflare and Bedrock',
    models: [
      { key: 'cerebras::gpt-oss-120b', temperature: 0.6, maxTokens: 5120 },
      { key: 'cloudflare::@cf/zai-org/glm-4.7-flash', temperature: 0.6, maxTokens: 5120 },
      { key: 'cloudflare::@cf/meta/llama-3.3-70b-instruct-fp8-fast', temperature: 0.6, maxTokens: 5120 },
      { key: 'cloudflare::@cf/moonshotai/kimi-k2.6', temperature: 0.6, maxTokens: 5120 },
      { key: 'bedrock::us.anthropic.claude-haiku-4-5-20251001-v1:0', temperature: 0.6, maxTokens: 5120 },
      { key: 'bedrock::google.gemma-3-12b-it', temperature: 0.6, maxTokens: 5120 },
      { key: 'bedrock::amazon.nova-lite-v1:0', temperature: 0.6, maxTokens: 5120 },
      { key: 'bedrock::mistral.ministral-3-14b-instruct', temperature: 0.6, maxTokens: 5120 },
    ],
  },
  {
    id: 'route-latency',
    label: 'Route latency',
    description: '4 model pairs — same model on two routes, isolates infrastructure latency',
    models: [
      { key: 'cerebras::gpt-oss-120b', temperature: 0.6, maxTokens: 5120 },
      { key: 'cloudflare::@cf/openai/gpt-oss-120b', temperature: 0.6, maxTokens: 5120 },
      { key: 'cloudflare::@cf/meta/llama-3.3-70b-instruct-fp8-fast', temperature: 0.6, maxTokens: 5120 },
      { key: 'bedrock::us.meta.llama3-3-70b-instruct-v1:0', temperature: 0.6, maxTokens: 5120 },
      { key: 'cloudflare::@cf/google/gemma-3-12b-it', temperature: 0.6, maxTokens: 5120 },
      { key: 'bedrock::google.gemma-3-12b-it', temperature: 0.6, maxTokens: 5120 },
      { key: 'cloudflare::@cf/nvidia/nemotron-3-120b-a12b', temperature: 0.6, maxTokens: 5120 },
      { key: 'bedrock::nvidia.nemotron-super-3-120b', temperature: 0.6, maxTokens: 5120 },
    ],
  },
];

function renderEvalModelRow(catalog, preset = {}) {
  const selectedKey = preset.key || firstAvailableKey(catalog);
  const temperature = preset.temperature ?? 0.6;
  const maxTokens = preset.maxTokens ?? 5120;
  return `
    <div class="admin-experiment-variant-row" data-variant-row>
      <span class="admin-experiment-variant-index" data-role="index">#1</span>
      <label class="admin-experiment-variant-field admin-experiment-variant-model">
        <span>Model</span>
        <input type="search" class="admin-model-search" placeholder="Filter models…" autocomplete="off" aria-label="Filter model list">
        <select name="model" required>
          ${renderModelOptions(catalog, selectedKey)}
        </select>
      </label>
      <label class="admin-experiment-variant-field">
        <span>Temp</span>
        <input type="number" name="temperature" step="0.05" min="0" max="2" value="${esc(temperature)}" required>
      </label>
      <label class="admin-experiment-variant-field">
        <span>Max tok</span>
        <input type="number" name="maxTokens" step="64" min="256" max="16384" value="${esc(maxTokens)}" required>
      </label>
      <div class="admin-experiment-variant-actions">
        <button type="button" class="admin-experiment-variant-btn" data-action="dup" aria-label="Duplicate this row" title="Duplicate this row">Duplicate</button>
        <button type="button" class="admin-experiment-variant-btn admin-experiment-variant-btn-remove" data-action="remove" aria-label="Remove this row" title="Remove this row">Remove</button>
      </div>
    </div>
  `;
}

function collectModelsFromForm(form) {
  const models = [];
  form.querySelectorAll('[data-variant-row]').forEach((row) => {
    const select = row.querySelector('select[name="model"]');
    const [provider, ...modelParts] = (select.value || '').split('::');
    const model = modelParts.join('::');
    if (!provider || !model) return;
    const temperature = parseFloat(row.querySelector('input[name="temperature"]').value);
    const maxTokens = parseInt(row.querySelector('input[name="maxTokens"]').value, 10);
    const label = select.selectedOptions[0]?.textContent?.replace(/\s+—\s+needs.*$/, '')?.trim() || `${provider} · ${model}`;
    models.push({
      provider,
      model,
      label,
      temperature: Number.isNaN(temperature) ? null : temperature,
      maxTokens: Number.isNaN(maxTokens) ? null : maxTokens,
    });
  });
  return models;
}

async function renderEvaluationCreateForm(root) {
  root.innerHTML = '<p class="admin-loading">Loading suites and models…</p>';
  let catalog;
  let suites;
  let judgeModels;
  try {
    const [catRes, suiteRes] = await Promise.all([
      api('/api/admin/catalog'),
      api('/api/admin/eval-suites'),
    ]);
    catalog = catRes.catalog || [];
    suites = suiteRes.suites || [];
    judgeModels = suiteRes.judgeModels || [];
  } catch (err) {
    root.innerHTML = `<p class="admin-error">${esc(err.message)}</p>`;
    return;
  }
  if (!suites.length) {
    root.innerHTML = '<p class="admin-error">No evaluation suites found.</p>';
    return;
  }

  const defaultSuite = suites[0];
  const defaultJudge = judgeModels.find((m) => m.id === 'claude-sonnet-4-6') || judgeModels[0];

  root.innerHTML = `
    <nav class="admin-crumbs"><a href="#/evaluations">← Evaluations</a></nav>
    <div class="admin-toolbar">
      <h2>New evaluation</h2>
    </div>

    <section class="admin-card">
      <h3>1. Suite</h3>
      <p class="admin-muted">A bundled set of coffee queries to run against every model.</p>
      <form id="admin-eval-form" class="admin-experiment-form">
        <label class="admin-field admin-field-wide">
          <span>Suite</span>
          <select name="suiteId" required>
            ${suites.map((s) => `<option value="${esc(s.id)}"${s.id === defaultSuite.id ? ' selected' : ''}>${esc(s.name)} · ${s.queryCount} queries</option>`).join('')}
          </select>
          <small class="admin-muted" data-role="suite-description">${esc(defaultSuite.description)}</small>
        </label>

        <h3>2. Models under test</h3>
        <p class="admin-muted">Up to ${MAX_EVAL_MODELS} models. Each runs against every query in the suite.</p>
        <div class="admin-eval-presets">
          <span class="admin-muted">Quick pick:</span>
          ${EVAL_MODEL_PRESETS.map((p) => `<button type="button" class="admin-btn admin-btn-ghost admin-eval-preset-btn" data-preset="${esc(p.id)}" title="${esc(p.description)}">${esc(p.label)}</button>`).join('')}
        </div>
        <div class="admin-experiment-variants" data-role="variants">
          ${renderEvalModelRow(catalog)}
        </div>
        <div class="admin-experiment-variant-footer">
          <button type="button" class="admin-btn admin-btn-ghost" data-role="add-variant">+ Add model</button>
        </div>

        <h3>3. Judge</h3>
        <p class="admin-muted">Claude scores each generation 1–5 on seven dimensions (structure, intent, faithfulness, helpfulness, brand voice, specificity, visual/asset usage); the cell score is the mean (range 1.00–5.00). Cost depends on the model and the suite size.</p>
        <label class="admin-field">
          <span>Judge model</span>
          <select name="judgeModel" required>
            ${judgeModels.map((m) => `<option value="${esc(m.id)}"${m.id === defaultJudge?.id ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}
          </select>
        </label>
        ${QUALITY_RUBRIC_HTML}

        <h3>4. Parallelism</h3>
        <p class="admin-muted">How many queries to run in parallel. Higher = faster wall time, but more pressure on the upstream LLM and Vectorize. Within each query, all models still run in parallel.</p>
        <label class="admin-field">
          <span>Queries in parallel</span>
          <input type="number" name="queryConcurrency" min="1" max="6" step="1" value="3" required>
        </label>

        <label class="admin-field admin-field-checkbox">
          <input type="checkbox" name="skipJudge">
          <span>Skip judging — generate now, judge later from the matrix view (use this if Bedrock is throttling).</span>
        </label>

        <div class="admin-experiment-actions">
          <button type="submit" class="admin-btn admin-btn-primary" data-role="run">Run evaluation</button>
          <button type="button" class="admin-btn admin-btn-ghost" data-role="cancel" hidden>Cancel</button>
          <span class="admin-experiment-summary admin-muted" data-role="summary">${defaultSuite.queryCount} queries × 1 model</span>
        </div>
      </form>
    </section>

    <section class="admin-card admin-experiment-progress" hidden data-role="progress-card">
      <h3>Progress</h3>
      <div class="admin-experiment-progress-meta">
        <span data-role="progress-phase">Waiting…</span>
        <span class="admin-muted" data-role="progress-ids"></span>
      </div>
      <div class="admin-experiment-progress-action" data-role="progress-action"></div>
      <table class="admin-table admin-eval-progress-table" data-role="progress-table" hidden>
        <thead><tr><th>Query</th><th>Status</th><th>Done</th><th>Judged</th></tr></thead>
        <tbody></tbody>
      </table>
    </section>
  `;

  const form = root.querySelector('#admin-eval-form');
  const summaryEl = form.querySelector('[data-role="summary"]');
  const runBtn = form.querySelector('[data-role="run"]');
  const variantsContainer = form.querySelector('[data-role="variants"]');
  const addBtn = form.querySelector('[data-role="add-variant"]');
  const suiteSelect = form.querySelector('select[name="suiteId"]');
  const suiteDescEl = form.querySelector('[data-role="suite-description"]');
  const progressCard = root.querySelector('[data-role="progress-card"]');
  const progressPhase = root.querySelector('[data-role="progress-phase"]');
  const progressIds = root.querySelector('[data-role="progress-ids"]');
  const progressAction = root.querySelector('[data-role="progress-action"]');
  const progressTable = root.querySelector('[data-role="progress-table"]');
  const progressTbody = progressTable.querySelector('tbody');

  const rowNodes = () => [...variantsContainer.querySelectorAll('[data-variant-row]')];

  const refreshSummary = () => {
    const rows = rowNodes();
    rows.forEach((row, i) => {
      row.querySelector('[data-role="index"]').textContent = `#${i + 1}`;
      const removeBtn = row.querySelector('[data-action="remove"]');
      if (removeBtn) removeBtn.disabled = rows.length === 1;
    });
    addBtn.disabled = rows.length >= MAX_EVAL_MODELS;
    const suite = suites.find((s) => s.id === suiteSelect.value) || suites[0];
    summaryEl.textContent = `${suite.queryCount} queries × ${rows.length} model${rows.length === 1 ? '' : 's'} = ${suite.queryCount * rows.length} generations`;
  };

  suiteSelect.addEventListener('change', () => {
    const suite = suites.find((s) => s.id === suiteSelect.value);
    if (suite) suiteDescEl.textContent = suite.description || '';
    refreshSummary();
  });

  variantsContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const row = btn.closest('[data-variant-row]');
    if (!row) return;
    if (btn.dataset.action === 'remove') {
      if (rowNodes().length > 1) row.remove();
      refreshSummary();
    } else if (btn.dataset.action === 'dup') {
      if (rowNodes().length >= MAX_EVAL_MODELS) return;
      const select = row.querySelector('select[name="model"]');
      const temp = row.querySelector('input[name="temperature"]').value;
      const maxTok = row.querySelector('input[name="maxTokens"]').value;
      const clone = document.createElement('div');
      clone.innerHTML = renderEvalModelRow(catalog, {
        key: select.value, temperature: temp, maxTokens: maxTok,
      }).trim();
      row.insertAdjacentElement('afterend', clone.firstElementChild);
      refreshSummary();
    }
  });

  variantsContainer.addEventListener('change', refreshSummary);
  variantsContainer.addEventListener('input', (e) => {
    if (e.target.classList.contains('admin-model-search')) {
      const row = e.target.closest('[data-variant-row]');
      if (row) filterModelSelect(e.target, row.querySelector('select[name="model"]'), catalog);
    }
    refreshSummary();
  });

  addBtn.addEventListener('click', () => {
    if (rowNodes().length >= MAX_EVAL_MODELS) return;
    const last = rowNodes().at(-1);
    const select = last?.querySelector('select[name="model"]');
    const temp = last?.querySelector('input[name="temperature"]').value;
    const maxTok = last?.querySelector('input[name="maxTokens"]').value;
    const clone = document.createElement('div');
    clone.innerHTML = renderEvalModelRow(catalog, {
      key: select?.value, temperature: temp, maxTokens: maxTok,
    }).trim();
    variantsContainer.appendChild(clone.firstElementChild);
    refreshSummary();
  });

  form.querySelector('.admin-eval-presets').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-preset]');
    if (!btn) return;
    const preset = EVAL_MODEL_PRESETS.find((p) => p.id === btn.dataset.preset);
    if (!preset) return;
    const rows = preset.models.slice(0, MAX_EVAL_MODELS);
    variantsContainer.innerHTML = rows.map((m) => renderEvalModelRow(catalog, m)).join('');
    refreshSummary();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const suiteId = suiteSelect.value;
    const judgeModel = form.querySelector('select[name="judgeModel"]').value;
    const queryConcurrencyRaw = parseInt(form.querySelector('input[name="queryConcurrency"]').value, 10);
    const queryConcurrency = Number.isNaN(queryConcurrencyRaw)
      ? 3 : Math.max(1, Math.min(6, queryConcurrencyRaw));
    const skipJudge = form.querySelector('input[name="skipJudge"]')?.checked === true;
    const models = collectModelsFromForm(form);
    if (!models.length) { summaryEl.textContent = 'Select at least one model.'; return; }

    runBtn.disabled = true;
    progressCard.hidden = false;
    progressTable.hidden = true;
    progressTbody.innerHTML = '';
    progressPhase.textContent = 'Starting…';
    progressIds.textContent = '';
    progressAction.innerHTML = '';

    try {
      const result = await api('/api/admin/evaluations/start', {
        method: 'POST',
        body: JSON.stringify({
          suiteId, models, judgeModel, queryConcurrency, skipJudge,
        }),
      });
      if (result.evalRunId) {
        navigate(`#/evaluations/${result.evalRunId}`);
      }
    } catch (err) {
      progressPhase.textContent = `Error: ${err.message}`;
      runBtn.disabled = false;
    }
  });

  refreshSummary();
}

function parseEvaluatorNotes(notesJson) {
  if (!notesJson) return null;
  try { return JSON.parse(notesJson); } catch { return null; }
}

function categorizeError(message) {
  if (!message) return 'error';
  const m = message.toLowerCase();
  if (/not found in kv|payload missing/i.test(m)) return 'KV missing';
  if (/429|rate.?limit/i.test(m)) return 'rate limited';
  if (/timeout|timed?\s*out/i.test(m)) return 'timeout';
  if (/token.*limit|too.*long|max.*token/i.test(m)) return 'token limit';
  if (/auth|401|403|credential/i.test(m)) return 'auth failed';
  if (/no blocks|empty/i.test(m)) return 'no output';
  if (/5\d\d|internal.*error|overloaded/i.test(m)) return 'server error';
  if (/network|fetch|connect/i.test(m)) return 'network error';
  return 'error';
}

async function renderEvaluation(root, evalRunId) {
  // Clear any existing poll interval from a previous render
  if (root.evalPollTimer) {
    clearInterval(root.evalPollTimer);
    root.evalPollTimer = null;
  }
  root.innerHTML = '<p class="admin-loading">Loading evaluation…</p>';
  let data;
  try {
    data = await api(`/api/admin/evaluations/${evalRunId}?include=feedback`);
  } catch (err) {
    root.innerHTML = `<p class="admin-error">${esc(err.message)}</p>`;
    return;
  }

  const { run, suite } = data;
  const experiments = data.experiments || [];
  const variants = data.variants || [];
  const feedbackByQuery = data.feedbackByQuery || {};
  const models = (() => {
    try { return JSON.parse(run.models_json || '[]'); } catch { return []; }
  })();
  const summary = (() => {
    try { return run.summary_json ? JSON.parse(run.summary_json) : null; } catch { return null; }
  })();

  // Build matrix: queryId -> array of variant rows aligned to models[].
  const variantsByExp = new Map();
  variants.forEach((v) => {
    if (!variantsByExp.has(v.experiment_id)) variantsByExp.set(v.experiment_id, []);
    variantsByExp.get(v.experiment_id).push(v);
  });

  const matrix = experiments.map((exp) => {
    const rows = variantsByExp.get(exp.id) || [];
    const cells = models.map(
      (m) => rows.find((v) => v.provider === m.provider && v.model === m.model) || null,
    );
    return { exp, cells };
  });

  // Detect queries from the suite that never ran (no experiment row in D1).
  const ranQueryIds = new Set(experiments.map((e) => e.eval_query_id));
  const missingQueries = (suite?.queries || []).filter((q) => !ranQueryIds.has(q.id));
  missingQueries.forEach((q) => {
    matrix.push({
      exp: {
        id: null, eval_query_id: q.id, query: q.query, missing: true,
      },
      cells: models.map(() => null),
    });
  });
  // Sort matrix: completed queries in suite order, missing queries at the end.
  const suiteOrder = new Map((suite?.queries || []).map((q, i) => [q.id, i]));
  matrix.sort((a, b) => {
    const aIdx = suiteOrder.get(a.exp.eval_query_id) ?? 999;
    const bIdx = suiteOrder.get(b.exp.eval_query_id) ?? 999;
    return aIdx - bIdx;
  });

  // Mutable references so refreshMatrix updates are reflected in cell rendering
  // and delegated event handlers see the freshest data after each poll cycle.
  let currentRun = run;
  let currentExperiments = experiments;
  let currentVariants = variants;

  const cellStatusLabel = (cellClass) => {
    if (cellClass === 'running') return 'generating…';
    if (cellClass === 'pending') return currentRun.phase === 'judging' ? 'judging…' : 'awaiting judge';
    if (cellClass === 'notStarted') return 'not started';
    return '…';
  };

  const renderQualityCell = (notes, score, tone, judgeError, status, genError, cellClass) => {
    if (score != null) {
      const dims = notes
        ? `<span class="admin-eval-cell-dims" title="structure / intent / faithfulness / helpfulness / brand voice / specificity / visual">${notes.structure?.score || '—'}·${notes.intent?.score || '—'}·${notes.faithfulness?.score || '—'}·${notes.helpfulness?.score || '—'}·${notes.brandVoice?.score || '—'}·${notes.specificity?.score || '—'}·${notes.visualAssetUsage?.score || '—'}</span>`
        : '';
      return `<span class="admin-badge admin-badge-${tone}">${score.toFixed(2)}</span>${dims}`;
    }
    if (judgeError) {
      const cat = categorizeError(judgeError);
      return `<span class="admin-error-text" title="${esc(judgeError)}">${esc(cat)}</span>`;
    }
    if (status === 'error') {
      const cat = categorizeError(genError);
      const preview = (genError || '').substring(0, 40);
      return `<span class="admin-error-text" title="${esc(genError || 'generation failed')}">${esc(cat)}</span><span class="admin-eval-cell-error-detail" title="${esc(genError || '')}">${esc(preview)}</span>`;
    }
    return `<span class="admin-muted">${cellStatusLabel(cellClass)}</span>`;
  };

  const renderBlockerRow = (notes) => {
    if (!notes) return '';
    const isBlocker = notes.blocker === true;
    const reasons = Array.isArray(notes.blocker_reasons) ? notes.blocker_reasons : [];
    const violations = Array.isArray(notes.assertions?.violations)
      ? notes.assertions.violations : [];
    const blockerViolations = violations.filter((v) => v.severity === 'blocker');
    const warnViolations = violations.filter((v) => v.severity === 'warn');
    if (!isBlocker && !blockerViolations.length && !warnViolations.length) return '';
    const tip = [...reasons, ...violations.map((v) => `${v.severity}: ${v.category} — ${v.message}`)]
      .filter(Boolean).join(' · ');
    if (isBlocker || blockerViolations.length) {
      const blockerBadge = `<span class="admin-eval-cell-blocker" title="${esc(tip)}">⚠ blocker${blockerViolations.length ? ` (${blockerViolations.length})` : ''}</span>`;
      return `<div class="admin-eval-cell-row admin-eval-cell-flags">${blockerBadge}</div>`;
    }
    if (warnViolations.length) {
      return `<div class="admin-eval-cell-row admin-eval-cell-flags"><span class="admin-eval-cell-warn" title="${esc(tip)}">${warnViolations.length} warn</span></div>`;
    }
    return '';
  };

  // Classify a cell so the toolbar counts and retry buttons can act on it.
  // judged     — score persisted, no error
  // pending    — generation succeeded, no judge run yet
  // judgeErr   — generation succeeded, but judge call failed
  // genErr     — generation failed (status='error')
  // stalled    — variant row exists with status='running' but the run is no longer active
  // notStarted — cell is null in a missing-query row (query never ran)
  // running    — generation actively in progress
  const isRunActive = () => currentRun.status === 'running' || currentRun.status === 'skip_judge'
    || currentRun.phase === 'generating' || currentRun.phase === 'judging';
  const classifyCell = (cell, isMissingRow) => {
    if (!cell) return isMissingRow ? 'notStarted' : 'empty';
    const notes = parseEvaluatorNotes(cell.evaluator_notes);
    if (notes?.judge_error) return 'judgeErr';
    if (cell.status === 'error') return 'genErr';
    if (cell.evaluator_score != null) return 'judged';
    if (cell.status === 'complete') return 'pending';
    if (cell.status === 'running' && !isRunActive()) return 'stalled';
    return 'running';
  };

  // Signature for one cell — captures everything that affects render output.
  // Used by refreshMatrix to skip unchanged cells (no DOM thrash, no scroll loss).
  const cellSignature = (cell, exp) => {
    const cellClass = classifyCell(cell, exp.missing === true);
    if (!cell) return `null|${cellClass}`;
    const notesLen = cell.evaluator_notes ? String(cell.evaluator_notes).length : 0;
    return [
      cellClass,
      cell.id || '',
      cell.status || '',
      cell.duration_ms || 0,
      cell.time_to_first_token_ms || 0,
      cell.evaluator_score == null ? '' : String(cell.evaluator_score),
      cell.error ? '1' : '0',
      notesLen,
      cell.output_tokens || 0,
      cell.input_tokens || 0,
    ].join('|');
  };

  const cellHtmlInner = (cell, exp) => {
    const isMissing = exp.missing === true;
    if (!cell) {
      if (isMissing) {
        return '<td class="admin-eval-cell admin-eval-cell-not-started"><span class="admin-muted">not started</span></td>';
      }
      return '<td class="admin-eval-cell admin-eval-cell-empty">—</td>';
    }
    const notes = parseEvaluatorNotes(cell.evaluator_notes);
    const { evaluator_score: score, status } = cell;
    const tone = QUALITY_TONE(score);
    const tps = (cell.output_tokens && cell.duration_ms)
      ? Math.round(cell.output_tokens / (cell.duration_ms / 1000))
      : null;
    const judgeError = notes?.judge_error;
    const genError = cell.error || null;
    const cellClass = classifyCell(cell, isMissing);
    if (cellClass === 'stalled') {
      return `<td class="admin-eval-cell admin-eval-cell-stalled admin-eval-cell-class-stalled" data-experiment-id="${esc(exp.id)}" data-variant-id="${esc(cell.id)}" data-cell-class="stalled">
        <div class="admin-eval-cell-retry-group">
          <button type="button" class="admin-eval-cell-retry" data-action="retry" data-retry-action="regenerate" title="Regenerate — re-run full pipeline + judge">↻ gen</button>
        </div>
        <span class="admin-error-text">stalled</span>
        <span class="admin-eval-cell-error-detail">generation did not complete</span>
      </td>`;
    }
    const ttftLabel = cell.time_to_first_token_ms != null
      ? `TTFT ${dur(cell.time_to_first_token_ms)}`
      : 'TTFT —';
    // Both retry actions are always available so the user can regenerate
    // (full pipeline + judge) or re-judge from KV regardless of cell state.
    // Re-judge is hidden for genErr/stalled cells because there are no blocks in KV.
    const showRejudge = cellClass !== 'genErr' && cellClass !== 'stalled';
    return `<td class="admin-eval-cell admin-eval-cell-${status} admin-eval-cell-class-${cellClass}" data-experiment-id="${esc(exp.id)}" data-variant-id="${esc(cell.id)}" data-cell-class="${cellClass}">
      <div class="admin-eval-cell-retry-group">
        <button type="button" class="admin-eval-cell-retry" data-action="retry" data-retry-action="regenerate" title="Regenerate — re-run full pipeline + judge">↻ gen</button>
        ${showRejudge ? '<button type="button" class="admin-eval-cell-retry" data-action="retry" data-retry-action="rejudge" title="Re-judge only — uses persisted blocks (cheap)">↻ judge</button>' : ''}
      </div>
      <div class="admin-eval-cell-row admin-eval-cell-speed">
        <span class="admin-eval-cell-ttft">${ttftLabel}</span>
        <span class="admin-eval-cell-duration">${dur(cell.duration_ms)}</span>
        ${tps ? `<span class="admin-eval-cell-tps">${tps}/s</span>` : ''}
      </div>
      <div class="admin-eval-cell-row admin-eval-cell-quality">
        ${renderQualityCell(notes, score, tone, judgeError, status, genError, cellClass)}
      </div>
      ${renderBlockerRow(notes)}
    </td>`;
  };

  // Inject data-signature so refreshMatrix can diff cells.
  const cellHtml = (cell, exp) => {
    const sig = cellSignature(cell, exp);
    return cellHtmlInner(cell, exp).replace(/^<td/, `<td data-signature="${esc(sig)}"`);
  };

  // Parse `<td>…</td>` HTML into a real <td> element (table context required).
  const parseTdHtml = (html) => {
    const tpl = document.createElement('template');
    tpl.innerHTML = `<table><tbody><tr>${html}</tr></tbody></table>`;
    return tpl.content.querySelector('td');
  };

  // Aggregate cell counts for the toolbar — drives Run/Continue judging and
  // Retry failed cells visibility + N counts.
  const counts = matrix.reduce((acc, { exp, cells }) => {
    const isMissing = exp.missing === true;
    cells.forEach((c) => {
      const k = classifyCell(c, isMissing);
      acc[k] = (acc[k] || 0) + 1;
    });
    return acc;
  }, {
    judged: 0, pending: 0, judgeErr: 0, genErr: 0, running: 0, empty: 0, notStarted: 0, stalled: 0,
  });
  const totalGenerated = counts.judged + counts.pending + counts.judgeErr;
  const failedCount = counts.genErr + counts.judgeErr + counts.stalled;

  const queryLabel = (exp) => {
    const def = suite?.queries?.find((q) => q.id === exp.eval_query_id);
    const label = def?.query || exp.query || '—';
    const truncated = label.length > 90 ? `${label.substring(0, 90)}…` : label;
    const fb = feedbackByQuery[exp.query || label] || null;
    let fbChip = '';
    if (fb && (fb.up > 0 || fb.down > 0)) {
      fbChip = `<a class="admin-eval-feedback-chip" href="#/feedback?q=${encodeURIComponent(exp.query || label)}" onclick="event.stopPropagation()" title="Real-user feedback for this query">👍 ${esc(fb.up || 0)} 👎 ${esc(fb.down || 0)}</a>`;
    }
    return `<span class="admin-eval-query-label" title="${esc(label)}">${esc(truncated)}</span><span class="admin-muted admin-eval-query-id">${esc(exp.eval_query_id || '')}</span>${fbChip}`;
  };

  // Signature for a row's query-label cell. Captures missing→ran transition
  // and feedback chip count changes — both of which can update mid-poll.
  const queryLabelSignature = (exp) => {
    const fb = feedbackByQuery[exp.query || ''] || null;
    const fbKey = fb ? `${fb.up || 0}:${fb.down || 0}` : '';
    return `${exp.id || ''}|${exp.missing ? 'm' : 'ok'}|${fbKey}`;
  };

  const rowKeyOf = (exp) => (exp.id || `missing-${exp.eval_query_id}`);

  // Copy attributes from `source` onto `target` element. Used to update a
  // <td>'s class / data-* in place without replacing the node itself.
  const syncAttributes = (target, source) => {
    [...target.attributes].forEach((attr) => {
      if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
    });
    [...source.attributes].forEach((attr) => {
      if (target.getAttribute(attr.name) !== attr.value) {
        target.setAttribute(attr.name, attr.value);
      }
    });
  };

  // Build the per-model summary card HTML. Returns '' when no perModel data
  // is available yet (the run hasn't finalized). Reused by initial render
  // AND by patchSummaryOnComplete so we never duplicate the markup.
  const summaryCardHtml = (s) => {
    if (!s?.perModel?.length) return '';
    return `<section class="admin-card" data-role="eval-summary-card">
        <h3>Per-model averages <span class="admin-muted admin-eval-score-hint">· quality scale 1.00 (worst) – 5.00 (best) · ± value is 95% CI half-width</span></h3>
        ${renderSignificanceHint(s.perModel)}
        <div class="admin-table-wrap"><table class="admin-table admin-eval-summary-table">
          <thead><tr>
            <th>Model</th><th>Quality</th>
            <th>Structure</th><th>Intent</th><th>Faithfulness</th><th>Helpfulness</th>
            <th>Brand voice</th><th>Specificity</th><th>Visual</th>
            <th>Blockers</th><th>Avg TTFT</th><th>Avg duration</th>
            <th>Tok in</th><th>Tok out</th><th>Errors</th>
          </tr></thead>
          <tbody>${s.perModel.map((m) => {
    const qualityCell = m.avgQuality != null
      ? `<span class="admin-badge admin-badge-${QUALITY_TONE(m.avgQuality)}">${m.avgQuality.toFixed(2)}</span>${m.qualityCi95 != null ? ` <span class="admin-muted admin-eval-ci">± ${m.qualityCi95.toFixed(2)}</span>` : ''}${m.qualityN ? ` <span class="admin-muted admin-eval-n">n=${m.qualityN}</span>` : ''}`
      : '—';
    const blockerCell = m.blockerCount > 0
      ? `<span class="admin-eval-cell-blocker">${m.blockerCount} (${Math.round((m.blockerRate || 0) * 100)}%)</span>`
      : '<span class="admin-muted">0</span>';
    const ttftCell = m.avgTtftMs != null
      ? `${dur(m.avgTtftMs)}${m.ttftCi95 != null ? ` <span class="admin-muted admin-eval-ci">± ${dur(m.ttftCi95)}</span>` : ''}`
      : '—';
    const durationCell = m.avgDurationMs != null
      ? `${dur(m.avgDurationMs)}${m.durationCi95 != null ? ` <span class="admin-muted admin-eval-ci">± ${dur(m.durationCi95)}</span>` : ''}`
      : '—';
    return `<tr>
            <td><strong>${esc(m.label)}</strong><br><span class="admin-muted admin-mono">${esc(m.provider)} · ${esc(m.model)}</span></td>
            <td>${qualityCell}</td>
            <td>${m.avgStructure != null ? m.avgStructure.toFixed(2) : '—'}</td>
            <td>${m.avgIntent != null ? m.avgIntent.toFixed(2) : '—'}</td>
            <td>${m.avgFaithfulness != null ? m.avgFaithfulness.toFixed(2) : '—'}</td>
            <td>${m.avgHelpfulness != null ? m.avgHelpfulness.toFixed(2) : '—'}</td>
            <td>${m.avgBrandVoice != null ? m.avgBrandVoice.toFixed(2) : '—'}</td>
            <td>${m.avgSpecificity != null ? m.avgSpecificity.toFixed(2) : '—'}</td>
            <td>${m.avgVisualAssetUsage != null ? m.avgVisualAssetUsage.toFixed(2) : '—'}</td>
            <td>${blockerCell}</td>
            <td>${ttftCell}</td>
            <td>${durationCell}</td>
            <td>${fmtInt(m.inputTokens || 0)}</td>
            <td>${fmtInt(m.outputTokens || 0)}</td>
            <td>${m.errors > 0 ? `<span class="admin-error-text">${m.errors}</span>` : '0'}</td>
          </tr>`;
  }).join('')}</tbody>
        </table></div>
      </section>`;
  };

  // Toolbar count chips. Rebuilt on every refresh so the user sees counts
  // decrement in real time.
  const toolbarCountsHtml = (c, totalGen, failed) => `
    <span class="admin-eval-count"><strong>${totalGen}</strong> generated</span>
    <span class="admin-eval-count admin-eval-count-judged"><strong>${c.judged}</strong> judged</span>
    <span class="admin-eval-count admin-eval-count-pending"><strong>${c.pending}</strong> pending</span>
    ${c.notStarted > 0 ? `<span class="admin-eval-count"><strong>${c.notStarted}</strong> not started</span>` : ''}
    ${c.stalled > 0 ? `<span class="admin-eval-count"><strong>${c.stalled}</strong> stalled</span>` : ''}
    <span class="admin-eval-count admin-eval-count-error"><strong>${failed}</strong> error${failed === 1 ? '' : 's'}</span>
  `;

  // Toolbar action buttons. Rebuilt on every refresh so buttons appear /
  // disappear as the run progresses. A delegated click listener handles
  // them by data-role, so freshly-rebuilt buttons still respond.
  const toolbarActionsHtml = (c, missingCount, failed) => `
    ${missingCount > 0 || c.genErr > 0 ? `<button type="button" class="admin-btn admin-btn-primary" data-role="continue-generation">Resume (${missingCount + c.genErr} failed/missing)</button>` : ''}
    ${c.pending > 0 ? `<button type="button" class="admin-btn${missingCount === 0 ? ' admin-btn-primary' : ''}" data-role="run-judging">${c.judged > 0 ? 'Continue judging' : 'Run judging'} (${c.pending})</button>` : ''}
    ${failed > 0 ? `<button type="button" class="admin-btn" data-role="retry-failed">Retry failed cells (${failed})</button>` : ''}
    <button type="button" class="admin-btn admin-btn-ghost" data-role="rejudge-all">Re-judge all</button>
  `;

  // Aggregate cell counts from a matrix shape — used for the toolbar refresh.
  const aggregateCounts = (m) => m.reduce((acc, { exp, cells: cs }) => {
    const isMiss = exp.missing === true;
    cs.forEach((c) => {
      const k = classifyCell(c, isMiss);
      acc[k] = (acc[k] || 0) + 1;
    });
    return acc;
  }, {
    judged: 0, pending: 0, judgeErr: 0, genErr: 0, running: 0, empty: 0, notStarted: 0, stalled: 0,
  });

  root.innerHTML = `
    <nav class="admin-crumbs"><a href="#/evaluations">← Evaluations</a></nav>
    <div class="admin-toolbar">
      <h2 class="admin-page-title">${esc(run.suite_name || run.suite_id)}</h2>
      <div class="admin-badges">
        ${badge(run.phase && (run.phase === 'generating' || run.phase === 'judging')
    ? `${run.phase} ${run.completed_queries || 0}/${run.query_count}`
    : (run.status || '—'), EVAL_STATUS_TONE[run.status] || 'muted')}
        ${badge(`${run.query_count} queries`, 'accent')}
        ${badge(`${run.model_count} models`, 'purple')}
        ${badge(run.judge_model || '—', 'warn')}
      </div>
    </div>

    <div class="admin-stats admin-stats-strip">
      <span class="admin-stat"><span class="admin-stat-value">${run.estimated_cost_usd != null ? `$${run.estimated_cost_usd.toFixed(2)}` : '—'}</span><span class="admin-stat-label">judge cost (est.)</span></span>
      <span class="admin-stat"><span class="admin-stat-value">${fmtInt(run.total_input_tokens || 0)}</span><span class="admin-stat-label">gen tokens in</span></span>
      <span class="admin-stat"><span class="admin-stat-value">${fmtInt(run.total_output_tokens || 0)}</span><span class="admin-stat-label">gen tokens out</span></span>
      <span class="admin-stat"><span class="admin-stat-value">${fmtInt((run.judge_input_tokens || 0) + (run.judge_output_tokens || 0))}</span><span class="admin-stat-label">judge tokens</span></span>
      <span class="admin-stat"><span class="admin-stat-value">${ts(run.created_at)}</span><span class="admin-stat-label">created</span></span>
    </div>

    ${summaryCardHtml(summary)}

    <section class="admin-card">
      <h3>Matrix · queries × models</h3>
      <p class="admin-muted">Each cell shows speed (TTFT, duration, tokens/sec) on top and Claude's quality score below (range 1.00 – 5.00). Click any cell to view that variant's generated page. Hover a cell and click ↻ to retry just that cell.</p>

      <div class="admin-eval-toolbar" data-role="eval-toolbar">
        <div class="admin-eval-counts">${toolbarCountsHtml(counts, totalGenerated, failedCount)}</div>
        <div class="admin-eval-toolbar-actions">${toolbarActionsHtml(counts, missingQueries.length, failedCount)}</div>
        <div class="admin-eval-toolbar-status admin-muted" data-role="toolbar-status"></div>
      </div>

      ${QUALITY_RUBRIC_HTML}
      <div class="admin-eval-matrix-wrap">
        <table class="admin-table admin-eval-matrix">
          <thead><tr>
            <th>Query</th>
            ${models.map((m) => `<th><div class="admin-eval-model-head"><strong>${esc(m.label)}</strong><span class="admin-muted admin-mono">${esc(m.provider)} · ${esc(m.model)}</span></div></th>`).join('')}
          </tr></thead>
          <tbody>${matrix.map(({ exp, cells }) => `<tr data-row-key="${esc(rowKeyOf(exp))}">
            <th class="admin-eval-query-cell" data-signature="${esc(queryLabelSignature(exp))}">${queryLabel(exp)}</th>
            ${cells.map((c) => cellHtml(c, exp)).join('')}
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </section>

    <section class="admin-card admin-experiment-flipthrough" data-role="preview-card" hidden>
      <h3>Variant preview</h3>
      <div class="admin-eval-preview-meta admin-muted" data-role="preview-meta"></div>
      <div class="admin-experiment-preview-slot" data-role="preview"></div>
    </section>
  `;

  const previewCard = root.querySelector('[data-role="preview-card"]');
  const previewSlot = root.querySelector('[data-role="preview"]');
  const previewMeta = root.querySelector('[data-role="preview-meta"]');
  const cache = new Map();

  // ── Retry actions ─────────────────────────────────────────────────────────
  const toolbarStatus = root.querySelector('[data-role="toolbar-status"]');
  const setToolbarStatus = (txt) => {
    if (toolbarStatus) toolbarStatus.textContent = txt || '';
  };

  const rejudgeOneCell = async (cellEl) => {
    const { variantId } = cellEl.dataset;
    cellEl.classList.add('admin-eval-cell-busy');
    cellEl.innerHTML = '<span class="admin-loading">Queued for re-judge…</span>';
    // Drop the signature so the next refresh always replaces this cell, even
    // if upstream data hasn't moved yet (queue dispatch is async).
    cellEl.removeAttribute('data-signature');
    try {
      const res = await fetch(
        `${ARCO_RECOMMENDER_URL}/api/admin/evaluations/${encodeURIComponent(evalRunId)}/variants/${encodeURIComponent(variantId)}/rejudge`,
        {
          method: 'POST',
          headers: { Authorization: `Basic ${btoa(`admin:${getAdminToken()}`)}` },
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      setToolbarStatus('Re-judge queued — polling for result…');
    } catch (err) {
      cellEl.classList.remove('admin-eval-cell-busy');
      setToolbarStatus(`Re-judge failed: ${err.message}`);
    }
  };

  const regenerateOneCell = async (cellEl) => {
    const { variantId } = cellEl.dataset;
    cellEl.classList.add('admin-eval-cell-busy');
    cellEl.innerHTML = '<span class="admin-loading">Queued for regeneration…</span>';
    cellEl.removeAttribute('data-signature');
    try {
      const res = await fetch(
        `${ARCO_RECOMMENDER_URL}/api/admin/evaluations/${encodeURIComponent(evalRunId)}/variants/${encodeURIComponent(variantId)}/regenerate`,
        {
          method: 'POST',
          headers: { Authorization: `Basic ${btoa(`admin:${getAdminToken()}`)}` },
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      setToolbarStatus('Regeneration queued — polling for result…');
    } catch (err) {
      cellEl.classList.remove('admin-eval-cell-busy');
      setToolbarStatus(`Regenerate failed: ${err.message}`);
    }
  };

  // Single delegated listener on tbody — survives per-cell DOM replacements
  // performed by refreshMatrix. Handles both retry buttons and cell-click preview.
  const matrixTbody = root.querySelector('.admin-eval-matrix tbody');
  if (matrixTbody) {
    matrixTbody.addEventListener('click', async (e) => {
      const retryBtn = e.target.closest('[data-action="retry"]');
      if (retryBtn) {
        e.stopPropagation();
        const td = retryBtn.closest('.admin-eval-cell[data-variant-id]');
        if (!td) return;
        const { retryAction: action } = retryBtn.dataset;
        const { cellClass } = td.dataset;
        if (action === 'regenerate') {
          if (cellClass === 'judged' && !window.confirm('Regenerate this cell? This re-runs the full pipeline (upstream LLM + judge tokens) and overwrites the existing result.')) return;
          if (cellClass === 'pending' && !window.confirm('Regenerate this cell? This re-runs the full pipeline including the upstream LLM. Use ↻ judge if you only need to score the existing generation.')) return;
          await regenerateOneCell(td);
        } else {
          if (cellClass === 'judged' && !window.confirm('Re-judge this cell? This overwrites the existing score and uses Bedrock tokens.')) return;
          await rejudgeOneCell(td);
        }
        return;
      }
      const td = e.target.closest('.admin-eval-cell[data-variant-id]');
      if (!td) return;
      const expId = td.dataset.experimentId;
      const varId = td.dataset.variantId;
      previewCard.hidden = false;
      const exp = currentExperiments.find((ex) => ex.id === expId);
      const variant = currentVariants.find((v) => v.id === varId);
      previewMeta.textContent = `${exp?.eval_query_id || ''} · ${variant?.provider || ''} · ${variant?.model || ''} · TTFT ${variant?.time_to_first_token_ms != null ? dur(variant.time_to_first_token_ms) : '—'} · duration ${dur(variant?.duration_ms)} · quality ${variant?.evaluator_score != null ? variant.evaluator_score.toFixed(2) : '—'}`;
      previewCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      await renderExperimentVariantPreview(previewSlot, expId, varId, cache);
    });
  }

  const runBulkJudge = async (scope, label) => {
    const btn = root.querySelector('[data-role="run-judging"]')
      || root.querySelector('[data-role="rejudge-all"]');
    if (btn) btn.disabled = true;
    setToolbarStatus(`${label}…`);
    try {
      const res = await fetch(
        `${ARCO_RECOMMENDER_URL}/api/admin/evaluations/${encodeURIComponent(evalRunId)}/judge`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${btoa(`admin:${getAdminToken()}`)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ scope }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      const result = await res.json();
      if (result.queued === 0) {
        setToolbarStatus('No variants to judge');
        if (btn) btn.disabled = false;
      } else {
        setToolbarStatus(`${label}: ${result.queued} cells queued — polling for progress…`);
      }
    } catch (err) {
      setToolbarStatus(`${label} failed: ${err.message}`);
      if (btn) btn.disabled = false;
    }
  };

  // Delegated handler — the actions area is rebuilt on every poll so the
  // counts (and which buttons are visible) stay accurate. Direct binding
  // would lose handlers on every refresh.
  const toolbarEl = root.querySelector('[data-role="eval-toolbar"]');
  if (toolbarEl) {
    toolbarEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-role]');
      if (!btn) return;
      const { role } = btn.dataset;

      if (role === 'continue-generation') {
        btn.disabled = true;
        setToolbarStatus('Resuming…');
        try {
          const result = await api(`/api/admin/evaluations/${evalRunId}/resume`, {
            method: 'POST',
          });
          setToolbarStatus(`Resumed ${result.resumed} / ${result.total} queries — polling for progress…`);
        } catch (err) {
          setToolbarStatus(`Resume failed: ${err.message}`);
        } finally {
          btn.disabled = false;
        }
        return;
      }

      if (role === 'run-judging') {
        runBulkJudge('pending', 'Judging pending cells');
        return;
      }

      if (role === 'rejudge-all') {
        if (!window.confirm('Re-judge ALL completed cells in this run? This will overwrite existing scores and use Bedrock tokens for every cell.')) return;
        runBulkJudge('all', 'Re-judging all cells');
        return;
      }

      if (role === 'retry-failed') {
        // Failed cells split into three groups:
        //   - genErr: must be regenerated (no blocks at all)
        //   - judgeErr with KV-missing message: must be regenerated (KV expired
        //     or pre-dates the rag-context persistence change)
        //   - judgeErr (other): cheap re-judge from KV is enough
        const variantsById = new Map(currentVariants.map((v) => [v.id, v]));
        const judgeErrIsKvMissing = (variant) => {
          const notes = parseEvaluatorNotes(variant?.evaluator_notes);
          const msg = notes?.judge_error || '';
          return /not found in KV/i.test(msg);
        };
        const genErrCells = [...root.querySelectorAll('.admin-eval-cell-class-genErr')];
        const stalledCells = [...root.querySelectorAll('.admin-eval-cell-class-stalled')];
        const judgeErrCells = [...root.querySelectorAll('.admin-eval-cell-class-judgeErr')];
        const judgeErrKvMissing = judgeErrCells
          .filter((td) => judgeErrIsKvMissing(variantsById.get(td.dataset.variantId)));
        const regenCells = [...genErrCells, ...stalledCells, ...judgeErrKvMissing];
        const judgeErrCount = judgeErrCells.length - judgeErrKvMissing.length;
        const failureSummary = `${regenCells.length} regen + ${judgeErrCount} re-judge`;
        if (!window.confirm(`Retry failed cells: ${failureSummary}? Regenerations cost upstream LLM tokens; re-judges cost Bedrock tokens.${judgeErrKvMissing.length ? `\n\n(${judgeErrKvMissing.length} judge errors will be regenerated because their stored blocks are missing from KV.)` : ''}`)) return;
        btn.disabled = true;
        try {
          if (regenCells.length) {
            await Promise.all(regenCells.map((td) => regenerateOneCell(td)));
          }
          if (judgeErrCount > 0) {
            await runBulkJudge('errors', 'Re-judging error cells');
          }
          const total = regenCells.length + judgeErrCount;
          setToolbarStatus(`Retry: ${total} cells queued — polling for progress…`);
        } catch (err) {
          setToolbarStatus(`Retry failed: ${err.message}`);
        } finally {
          btn.disabled = false;
        }
      }
    });
  }

  // Poll for progress — all operations are async via queues, so always poll
  // unless the run is finalized with no pending work.
  const phase = run.phase || null;
  const isActivePhase = phase === 'generating' || phase === 'judging';
  const hasIncompleteWork = isActivePhase || counts.running > 0 || counts.notStarted > 0
    || counts.pending > 0;

  if (hasIncompleteWork || phase !== 'complete') {
    const refreshMatrix = async () => {
      try {
        const freshData = await api(`/api/admin/evaluations/${evalRunId}?include=feedback`);
        const freshExperiments = freshData.experiments || [];
        const freshVariants = freshData.variants || [];
        const freshRun = freshData.run;
        currentRun = freshRun;
        // Refresh the closure-captured feedbackByQuery map so chips
        // re-render with the latest counts on the next poll cycle.
        if (freshData.feedbackByQuery) {
          Object.keys(feedbackByQuery).forEach((k) => delete feedbackByQuery[k]);
          Object.assign(feedbackByQuery, freshData.feedbackByQuery);
        }

        // Rebuild matrix rows
        const freshByExp = new Map();
        freshVariants.forEach((v) => {
          if (!freshByExp.has(v.experiment_id)) freshByExp.set(v.experiment_id, []);
          freshByExp.get(v.experiment_id).push(v);
        });
        const freshMatrix = freshExperiments.map((exp) => {
          const rows = freshByExp.get(exp.id) || [];
          const fCells = models.map(
            (m) => rows.find((v) => v.provider === m.provider && v.model === m.model) || null,
          );
          return { exp, cells: fCells };
        });
        const freshRanIds = new Set(freshExperiments.map((e) => e.eval_query_id));
        const freshMissing = (suite?.queries || []).filter((q) => !freshRanIds.has(q.id));
        freshMissing.forEach((q) => {
          freshMatrix.push({
            exp: {
              id: null, eval_query_id: q.id, query: q.query, missing: true,
            },
            cells: models.map(() => null),
          });
        });
        freshMatrix.sort((a, b) => {
          const aIdx = suiteOrder.get(a.exp.eval_query_id) ?? 999;
          const bIdx = suiteOrder.get(b.exp.eval_query_id) ?? 999;
          return aIdx - bIdx;
        });

        // Refresh closure-captured arrays so the delegated cell-click handler
        // resolves the latest variant/experiment when the user clicks a cell.
        currentExperiments = freshExperiments;
        currentVariants = freshVariants;

        // Patch the tbody in place — only touch cells whose signature changed.
        // Keeps scroll position stable and avoids re-creating cells the user
        // might be hovering over.
        const tbody = root.querySelector('.admin-eval-matrix tbody');
        if (tbody) {
          const existingRows = new Map();
          tbody.querySelectorAll(':scope > tr[data-row-key]').forEach((tr) => {
            existingRows.set(tr.dataset.rowKey, tr);
          });

          let prevRow = null;
          freshMatrix.forEach(({ exp, cells }) => {
            const key = rowKeyOf(exp);
            let row = existingRows.get(key);
            if (row) {
              existingRows.delete(key);
              // Move into correct order if out of place.
              const target = prevRow ? prevRow.nextElementSibling : tbody.firstChild;
              if (target !== row) tbody.insertBefore(row, target);

              // Update the query-label cell only if its signature changed.
              const labelCell = row.firstElementChild;
              const newLabelSig = queryLabelSignature(exp);
              if (labelCell && labelCell.dataset.signature !== newLabelSig) {
                labelCell.innerHTML = queryLabel(exp);
                labelCell.dataset.signature = newLabelSig;
              }

              // Diff each data cell. Update existing <td> in place (sync
              // attributes + innerHTML) so the cell element identity is
              // preserved — no node churn, no hover flash, no layout jitter.
              cells.forEach((c, i) => {
                const existingCell = row.children[i + 1];
                const newSig = cellSignature(c, exp);
                if (!existingCell) {
                  const newCell = parseTdHtml(cellHtml(c, exp));
                  if (newCell) row.appendChild(newCell);
                } else if (existingCell.dataset.signature !== newSig) {
                  const newCell = parseTdHtml(cellHtml(c, exp));
                  if (newCell) {
                    syncAttributes(existingCell, newCell);
                    existingCell.innerHTML = newCell.innerHTML;
                  }
                }
              });
              // Trim any stale cells (e.g. models removed mid-run — defensive).
              while (row.children.length > cells.length + 1) {
                row.lastElementChild.remove();
              }
            } else {
              // New row (e.g. a previously-missing query just started running).
              row = document.createElement('tr');
              row.dataset.rowKey = key;
              row.innerHTML = `<th class="admin-eval-query-cell" data-signature="${esc(queryLabelSignature(exp))}">${queryLabel(exp)}</th>${cells.map((c) => cellHtml(c, exp)).join('')}`;
              const target = prevRow ? prevRow.nextElementSibling : tbody.firstChild;
              tbody.insertBefore(row, target);
            }
            prevRow = row;
          });

          // Remove rows that no longer belong (e.g. missing→ran transition
          // changes the row key, so the old `missing-…` row drops out).
          existingRows.forEach((tr) => tr.remove());
        }

        // Patch the status badge only when its text changed.
        const badgesEl = root.querySelector('.admin-badges');
        if (badgesEl) {
          const p = freshRun.phase || null;
          const statusText = (p === 'generating' || p === 'judging')
            ? `${p} ${freshRun.completed_queries || 0}/${freshRun.query_count}`
            : (freshRun.status || '—');
          const firstBadge = badgesEl.querySelector('.admin-badge');
          if (firstBadge && firstBadge.textContent !== statusText) {
            firstBadge.textContent = statusText;
          }
        }

        // Patch the toolbar in place so counts decrement live and stale
        // buttons (e.g. "Run judging" with pending=0) disappear without a
        // full reload. The delegated click listener on the toolbar handles
        // freshly-rebuilt buttons.
        const freshCounts = aggregateCounts(freshMatrix);
        const freshTotalGen = freshCounts.judged + freshCounts.pending + freshCounts.judgeErr;
        const freshFailed = freshCounts.genErr + freshCounts.judgeErr + freshCounts.stalled;
        const freshMissingCount = (suite?.queries || [])
          .filter((q) => !freshRanIds.has(q.id)).length;
        const countsEl = root.querySelector('.admin-eval-counts');
        if (countsEl) {
          const next = toolbarCountsHtml(freshCounts, freshTotalGen, freshFailed);
          if (countsEl.innerHTML !== next) countsEl.innerHTML = next;
        }
        const actionsEl = root.querySelector('.admin-eval-toolbar-actions');
        if (actionsEl) {
          const next = toolbarActionsHtml(freshCounts, freshMissingCount, freshFailed);
          if (actionsEl.innerHTML !== next) actionsEl.innerHTML = next;
        }

        // Patch the per-model summary card. Appears for the first time when
        // the run finalizes; updates in place if it already exists.
        const freshSummary = (() => {
          try {
            return freshRun.summary_json ? JSON.parse(freshRun.summary_json) : null;
          } catch { return null; }
        })();
        const existingSummary = root.querySelector('[data-role="eval-summary-card"]');
        const nextSummaryHtml = summaryCardHtml(freshSummary);
        if (nextSummaryHtml && !existingSummary) {
          // Insert before the matrix section.
          const matrixSection = root.querySelector('.admin-eval-matrix-wrap')?.closest('section');
          if (matrixSection) matrixSection.insertAdjacentHTML('beforebegin', nextSummaryHtml);
        } else if (nextSummaryHtml && existingSummary
            && existingSummary.outerHTML !== nextSummaryHtml) {
          existingSummary.outerHTML = nextSummaryHtml;
        }

        return freshRun;
      } catch { return null; }
    };

    const poll = async () => {
      if (!root.isConnected || !root.querySelector('[data-role="eval-toolbar"]')) {
        clearInterval(root.evalPollTimer);
        root.evalPollTimer = null;
        return;
      }
      try {
        const freshRun = await refreshMatrix();
        if (freshRun) {
          const freshPhase = freshRun.phase || null;
          // refreshMatrix already patched the summary card, toolbar, and
          // matrix in place — nothing else to do on complete except stop
          // polling. No reload, no scroll restore.
          if (freshPhase === 'complete' && !root.querySelector('.admin-eval-cell-busy')) {
            clearInterval(root.evalPollTimer);
            root.evalPollTimer = null;
          }
        }
      } catch { /* ignore poll errors */ }
    };
    root.evalPollTimer = setInterval(poll, 3000);
    const observer = new MutationObserver(() => {
      if (!root.isConnected || !root.querySelector('[data-role="eval-toolbar"]')) {
        clearInterval(root.evalPollTimer);
        root.evalPollTimer = null;
        observer.disconnect();
      }
    });
    observer.observe(root, { childList: true });
  }
}

// ── User feedback ────────────────────────────────────────────────────────────

const FEEDBACK_FLAG_LABELS = {
  'wrong-product': 'Wrong product',
  'off-topic': 'Off-topic',
  'inappropriate-tone': 'Off-brand',
  'harmful-unsafe': 'Harmful',
};

function feedbackFlagBadges(flags) {
  if (!flags || !flags.length) return '<span class="admin-muted">—</span>';
  return flags.map((f) => {
    const tone = f === 'harmful-unsafe' ? 'warn' : 'accent';
    const label = FEEDBACK_FLAG_LABELS[f] || f;
    return badge(label, tone);
  }).join(' ');
}

function feedbackRatingChip(rating) {
  if (rating === 1) return '<span class="admin-badge admin-badge-ok">👍</span>';
  if (rating === -1) return '<span class="admin-badge admin-badge-warn">👎</span>';
  return '<span class="admin-badge admin-badge-muted">—</span>';
}

function buildFeedbackQueryString(filters) {
  const params = new URLSearchParams();
  if (filters.rating && filters.rating !== 'all') params.set('rating', filters.rating);
  if (filters.flag && filters.flag !== 'all') params.set('flag', filters.flag);
  if (filters.model) params.set('model', filters.model);
  if (filters.q) params.set('q', filters.q);
  if (filters.hasComment) params.set('hasComment', 'true');
  params.set('limit', String(filters.limit || 100));
  params.set('offset', String(filters.offset || 0));
  return params.toString();
}

async function renderFeedbackList(root) {
  root.innerHTML = '<p class="admin-loading">Loading feedback…</p>';

  const filters = {
    rating: 'all', flag: 'all', model: '', q: '', hasComment: false, limit: 100, offset: 0,
  };

  let summary;
  let listing;
  let models = [];
  try {
    [summary, listing] = await Promise.all([
      api('/api/admin/feedback/summary'),
      api(`/api/admin/feedback?${buildFeedbackQueryString(filters)}`),
    ]);
    try {
      const cat = await api('/api/admin/catalog');
      models = (cat.catalog || []).map((c) => c.model).filter(Boolean);
    } catch { /* models filter is optional */ }
  } catch (err) {
    root.innerHTML = `<p class="admin-error">${esc(err.message)}</p>`;
    return;
  }

  const modelOpts = ['<option value="">Any model</option>']
    .concat(models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`))
    .join('');

  const topFlag = (summary.topFlags && summary.topFlags[0]) || null;

  root.innerHTML = `
    <div class="admin-toolbar">
      <h2>User feedback</h2>
      <div class="admin-stats">
        <span class="admin-stat"><span class="admin-stat-value">${esc(summary.total || 0)}</span><span class="admin-stat-label">total</span></span>
        <span class="admin-stat"><span class="admin-stat-value">${esc(summary.percentPositive || 0)}%</span><span class="admin-stat-label">positive</span></span>
        <span class="admin-stat"><span class="admin-stat-value">${esc(summary.negative || 0)}</span><span class="admin-stat-label">negative</span></span>
        <span class="admin-stat"><span class="admin-stat-value">${esc(summary.comments || 0)}</span><span class="admin-stat-label">comments</span></span>
        <span class="admin-stat"><span class="admin-stat-value">${esc(summary.divergence || 0)}</span><span class="admin-stat-label">judge↔user diverge</span></span>
      </div>
    </div>

    ${topFlag ? `<p class="admin-muted">Top flag: <strong>${esc(FEEDBACK_FLAG_LABELS[topFlag.flag] || topFlag.flag)}</strong> — ${esc(topFlag.count)} of ${esc(summary.negative || 0)} downvotes (${esc(topFlag.percent)}%)</p>` : ''}

    <div class="admin-card admin-feedback-filters">
      <label>Rating
        <select data-filter="rating">
          <option value="all">All</option>
          <option value="up">👍 Positive</option>
          <option value="down">👎 Negative</option>
        </select>
      </label>
      <label>Flag
        <select data-filter="flag">
          <option value="all">Any</option>
          <option value="wrong-product">Wrong product</option>
          <option value="off-topic">Off-topic</option>
          <option value="inappropriate-tone">Off-brand</option>
          <option value="harmful-unsafe">Harmful</option>
        </select>
      </label>
      <label>Model
        <select data-filter="model">${modelOpts}</select>
      </label>
      <label>Query
        <input type="search" data-filter="q" placeholder="Substring match…" />
      </label>
      <label class="admin-feedback-check">
        <input type="checkbox" data-filter="hasComment" />
        Has comment
      </label>
      <div class="admin-feedback-export">
        <a class="admin-btn admin-btn-ghost" data-export="csv" href="${esc(ARCO_RECOMMENDER_URL)}/api/admin/feedback/export?format=csv" target="_blank" rel="noopener">Download CSV</a>
        <a class="admin-btn admin-btn-ghost" data-export="json" href="${esc(ARCO_RECOMMENDER_URL)}/api/admin/feedback/export?format=json" target="_blank" rel="noopener">Download NDJSON</a>
      </div>
    </div>

    <div class="admin-feedback-list" id="feedback-list"></div>
  `;

  function renderRows(items) {
    const target = root.querySelector('#feedback-list');
    if (!items.length) {
      target.innerHTML = '<p class="admin-empty">No feedback rows match the filters.</p>';
      return;
    }
    target.innerHTML = `
      <div class="admin-table-wrap"><table class="admin-table admin-feedback-table">
        <thead><tr>
          <th>When</th><th>Query</th><th>Rating</th><th>Flags</th>
          <th>Wrong products</th><th>Comment</th><th>Model</th>
        </tr></thead>
        <tbody>${items.map((r) => `
          <tr data-href="#/feedback/run/${esc(r.run_id)}">
            <td class="admin-muted">${ts(r.created_at * 1000)}</td>
            <td class="admin-query"><a href="#/pages/${esc(r.page_id || '')}" onclick="event.stopPropagation()">${esc((r.query || '').substring(0, 80))}</a></td>
            <td>${feedbackRatingChip(r.rating)}</td>
            <td>${feedbackFlagBadges(r.flags)}</td>
            <td class="admin-muted">${esc((r.wrong_products || []).join(', '))}</td>
            <td class="admin-comment">${esc((r.comment || '').substring(0, 140))}</td>
            <td class="admin-muted">${esc(r.llm_model || '—')}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>
    `;
    target.querySelectorAll('tr[data-href]').forEach((tr) => {
      tr.addEventListener('click', () => { navigate(tr.dataset.href); });
    });
  }

  renderRows(listing.items || []);

  async function reload() {
    try {
      const data = await api(`/api/admin/feedback?${buildFeedbackQueryString(filters)}`);
      renderRows(data.items || []);
    } catch (err) {
      root.querySelector('#feedback-list').innerHTML = `<p class="admin-error">${esc(err.message)}</p>`;
    }
  }

  function refreshExportLinks() {
    const exportParams = new URLSearchParams();
    if (filters.rating && filters.rating !== 'all') exportParams.set('rating', filters.rating);
    if (filters.flag && filters.flag !== 'all') exportParams.set('flag', filters.flag);
    const csv = root.querySelector('[data-export="csv"]');
    const json = root.querySelector('[data-export="json"]');
    csv.href = `${ARCO_RECOMMENDER_URL}/api/admin/feedback/export?format=csv${exportParams.toString() ? `&${exportParams.toString()}` : ''}`;
    json.href = `${ARCO_RECOMMENDER_URL}/api/admin/feedback/export?format=json${exportParams.toString() ? `&${exportParams.toString()}` : ''}`;
  }

  root.querySelectorAll('[data-filter]').forEach((el) => {
    const key = el.dataset.filter;
    const event = el.tagName === 'INPUT' && el.type === 'search' ? 'input' : 'change';
    el.addEventListener(event, () => {
      filters[key] = key === 'hasComment' ? el.checked : el.value;
      filters.offset = 0;
      refreshExportLinks();
      reload();
    });
  });
}

async function renderFeedbackRun(root, runId) {
  root.innerHTML = '<p class="admin-loading">Loading feedback…</p>';
  let data;
  try {
    data = await api(`/api/admin/feedback/run/${runId}`);
  } catch (err) {
    root.innerHTML = `<p class="admin-error">${esc(err.message)}</p>`;
    return;
  }

  const run = data.run || {};
  const feedback = data.feedback || [];
  const pageLink = run.page_id ? `<a href="#/pages/${esc(run.page_id)}">View generated page</a>` : '';

  root.innerHTML = `
    <nav class="admin-crumbs"><a href="#/feedback">← All feedback</a></nav>
    <div class="admin-toolbar">
      <h2>Feedback for ${esc((run.query || runId).substring(0, 80))}</h2>
      <div class="admin-badges">
        ${badge(`${feedback.length} row${feedback.length === 1 ? '' : 's'}`, 'accent')}
        ${run.llm_model ? badge(run.llm_model, 'muted') : ''}
        ${run.intent_type ? badge(run.intent_type, intentTone(run.intent_type)) : ''}
      </div>
    </div>

    <section class="admin-card">
      <h3>Run</h3>
      <dl class="admin-kvs">
        ${kv('Run ID', runId)}
        ${kv('Query', run.query)}
        ${kv('Title', run.title)}
        ${kv('Intent', run.intent_type)}
        ${kv('Journey stage', run.journey_stage)}
        ${kv('LLM', run.llm_provider && run.llm_model ? `${run.llm_provider} / ${run.llm_model}` : '—')}
        ${kv('Created', run.created_at ? ts(run.created_at * 1000) : '—')}
      </dl>
      ${pageLink ? `<p>${pageLink}</p>` : ''}
    </section>

    <section class="admin-card">
      <h3>Feedback rows</h3>
      ${feedback.length === 0
    ? '<p class="admin-empty">No feedback recorded for this run yet.</p>'
    : feedback.map((f) => `
          <div class="admin-feedback-row">
            <div class="admin-feedback-row-head">
              ${feedbackRatingChip(f.rating)}
              <span class="admin-muted">${ts(f.created_at * 1000)}</span>
              <span class="admin-muted admin-mono">${esc((f.session_id || '').substring(0, 8))}…</span>
              ${f.dwell_ms ? `<span class="admin-muted">dwell ${dur(f.dwell_ms)}</span>` : ''}
            </div>
            <div class="admin-feedback-row-flags">${feedbackFlagBadges(f.flags)}</div>
            ${f.wrong_products && f.wrong_products.length
    ? `<div class="admin-feedback-row-products"><strong>Wrong products:</strong> ${esc(f.wrong_products.join(', '))}</div>` : ''}
            ${f.comment ? `<blockquote class="admin-feedback-comment">${esc(f.comment)}</blockquote>` : ''}
          </div>
        `).join('')}
    </section>
  `;
}

async function renderFeedbackTab(panel, pageData) {
  panel.innerHTML = '<p class="admin-loading">Loading feedback…</p>';
  const runIds = (pageData.runs || []).map((r) => r.run?.id).filter(Boolean);
  if (!runIds.length) {
    panel.innerHTML = '<p class="admin-empty">No runs found for this page.</p>';
    return;
  }
  let results;
  try {
    results = await Promise.all(runIds.map((id) => api(`/api/admin/feedback/run/${id}`).catch(() => null)));
  } catch (err) {
    panel.innerHTML = `<p class="admin-error">${esc(err.message)}</p>`;
    return;
  }

  const sections = results.map((r, i) => {
    if (!r) return '';
    const runId = runIds[i];
    const rows = r.feedback || [];
    if (!rows.length) {
      return `<section class="admin-card">
        <h3>Run #${i + 1} <span class="admin-muted admin-mono">${esc(runId.substring(0, 8))}…</span></h3>
        <p class="admin-empty">No feedback for this run.</p>
      </section>`;
    }
    return `<section class="admin-card">
      <h3>Run #${i + 1} <span class="admin-muted admin-mono">${esc(runId.substring(0, 8))}…</span></h3>
      ${rows.map((f) => `
        <div class="admin-feedback-row">
          <div class="admin-feedback-row-head">
            ${feedbackRatingChip(f.rating)}
            <span class="admin-muted">${ts(f.created_at * 1000)}</span>
            <span class="admin-muted admin-mono">${esc((f.session_id || '').substring(0, 8))}…</span>
          </div>
          <div class="admin-feedback-row-flags">${feedbackFlagBadges(f.flags)}</div>
          ${f.wrong_products && f.wrong_products.length
    ? `<div class="admin-feedback-row-products"><strong>Wrong products:</strong> ${esc(f.wrong_products.join(', '))}</div>` : ''}
          ${f.comment ? `<blockquote class="admin-feedback-comment">${esc(f.comment)}</blockquote>` : ''}
        </div>
      `).join('')}
    </section>`;
  }).join('');

  panel.innerHTML = sections || '<p class="admin-empty">No feedback collected on this page yet.</p>';
}

/* ── Insights (marketing metrics / ROI) ─────────────────────────────────── */

const ROI_FIELDS = [
  ['author_hours_per_page', 'Author hours per page', 0.5],
  ['author_hourly_rate', 'Author hourly rate (USD)', 5],
  ['gross_margin_pct', 'Gross margin (%)', 1],
];

function usd(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (Math.abs(v) >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (Math.abs(v) >= 1) return `$${v.toFixed(2)}`;
  if (v === 0) return '$0';
  return `$${v.toFixed(4)}`;
}

function pctFmt(n, digits = 1) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return `${(Number(n) * 100).toFixed(digits)}%`;
}

function roiMultiple(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (v >= 1000) return `${Math.round(v).toLocaleString()}×`;
  if (v >= 10) return `${v.toFixed(0)}×`;
  return `${v.toFixed(1)}×`;
}

function statCard(label, value, sub) {
  return `
    <div class="admin-insight-stat">
      <span class="admin-insight-stat-label">${esc(label)}</span>
      <strong class="admin-insight-stat-value">${esc(String(value))}</strong>
      ${sub ? `<span class="admin-insight-stat-sub">${esc(sub)}</span>` : ''}
    </div>`;
}

function renderFunnel(funnel) {
  const top = funnel[0]?.sessions || 0;
  return funnel.map((step, i) => {
    const width = top ? Math.max(2, (step.sessions / top) * 100) : 2;
    return `
      <div class="admin-funnel-step">
        <div class="admin-funnel-head">
          <span class="admin-funnel-label">${esc(step.label)}</span>
          <span class="admin-funnel-count">${step.sessions.toLocaleString()} sessions</span>
        </div>
        <div class="admin-funnel-bar-track">
          <div class="admin-funnel-bar" style="width:${width}%"></div>
        </div>
        <div class="admin-funnel-meta admin-muted">
          ${i === 0 ? 'entry point' : `${pctFmt(step.stepRate)} of previous · ${pctFmt(step.overallRate)} overall · ${step.dropOff.toLocaleString()} dropped off`}
        </div>
      </div>`;
  }).join('');
}

function renderModelsTable(models) {
  if (!models.length) {
    return '<p class="admin-empty">No generations with a recorded model in this window.</p>';
  }
  return `
    <table class="admin-table admin-insight-table">
      <thead>
        <tr>
          <th>Model</th><th>Runs</th><th>Cost</th><th>$/run</th>
          <th>PDP views</th><th>Carts</th><th>Conv. rate</th>
          <th>Revenue/run</th><th>Judge</th><th>User</th>
        </tr>
      </thead>
      <tbody>
        ${models.map((m) => `
          <tr>
            <td><span class="admin-mono">${esc(m.provider || '?')}</span><br>${esc(m.model || '?')}</td>
            <td>${m.runs.toLocaleString()}</td>
            <td>${usd(m.costUsd)}</td>
            <td>${usd(m.costPerRunUsd)}</td>
            <td>${m.productViews.toLocaleString()}</td>
            <td>${m.carts.toLocaleString()}</td>
            <td>${pctFmt(m.cartConversionRate)}</td>
            <td>${usd(m.revenuePerRunUsd)}</td>
            <td>${m.judgeScore != null ? Number(m.judgeScore).toFixed(2) : '—'}</td>
            <td>👍${m.up} 👎${m.down}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function renderSegmentTable(title, rows) {
  if (!rows.length) return '';
  return `
    <div class="admin-insight-segment">
      <h4>${esc(title)}</h4>
      <table class="admin-table admin-insight-table">
        <thead><tr><th>Segment</th><th>Runs</th><th>Carts</th><th>Conv. rate</th><th>Value</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(r.segment)}</td>
              <td>${r.runs.toLocaleString()}</td>
              <td>${r.carts.toLocaleString()}</td>
              <td>${pctFmt(r.conversionRate)}</td>
              <td>${usd(r.cartValueUsd)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderTimeseries(series) {
  if (!series.length) return '<p class="admin-empty">No activity in this window.</p>';
  const max = Math.max(...series.map((d) => Math.max(d.costUsd, d.valueUsd)), 0.0001);
  return `
    <div class="admin-insight-chart">
      ${series.map((d) => `
        <div class="admin-insight-chart-col" title="${esc(d.day)} · cost ${usd(d.costUsd)} · value ${usd(d.valueUsd)}">
          <div class="admin-insight-bars">
            <div class="admin-insight-bar admin-insight-bar-value" style="height:${(d.valueUsd / max) * 100}%"></div>
            <div class="admin-insight-bar admin-insight-bar-cost" style="height:${(d.costUsd / max) * 100}%"></div>
          </div>
          <span class="admin-insight-chart-label">${esc(d.day.slice(5))}</span>
        </div>`).join('')}
    </div>
    <div class="admin-insight-legend admin-muted">
      <span><i class="admin-swatch admin-swatch-value"></i> attributed cart value</span>
      <span><i class="admin-swatch admin-swatch-cost"></i> inference cost</span>
    </div>`;
}

async function renderInsights(root) {
  const days = Number(new URLSearchParams(window.location.hash.split('?')[1] || '').get('days')) || 30;

  root.innerHTML = `
    <div class="admin-toolbar">
      <h2>Marketing insights &amp; ROI</h2>
      <div class="admin-toolbar-actions">
        <label class="admin-muted">Window
          <select data-role="days">
            ${[7, 30, 90, 365].map((d) => `<option value="${d}" ${d === days ? 'selected' : ''}>${d} days</option>`).join('')}
          </select>
        </label>
      </div>
    </div>
    <div data-role="body"><p class="admin-muted">Loading…</p></div>`;

  root.querySelector('[data-role="days"]').addEventListener('change', (e) => {
    window.location.hash = `#/insights?days=${e.target.value}`;
  });

  const body = root.querySelector('[data-role="body"]');
  const q = `?days=${days}`;

  let summary; let funnel; let models; let segments; let series;
  try {
    [summary, funnel, models, segments, series] = await Promise.all([
      api(`/api/admin/insights/summary${q}`),
      api(`/api/admin/insights/funnel${q}`),
      api(`/api/admin/insights/models${q}`),
      api(`/api/admin/insights/segments${q}`),
      api(`/api/admin/insights/timeseries${q}`),
    ]);
  } catch (err) {
    body.innerHTML = `<p class="admin-error">${esc(err.message)}</p>`;
    return;
  }

  const { generation: g, conversions: c, roi } = summary;

  body.innerHTML = `
    <section class="admin-card">
      <div class="admin-insight-stats">
        ${statCard('Generated runs', g.runs.toLocaleString(), `${g.sessions.toLocaleString()} sessions`)}
        ${statCard('Inference cost', usd(g.costUsd), `${usd(g.costPerRunUsd)} per run`)}
        ${statCard('Product views', c.productViews.toLocaleString(), 'soft conversion')}
        ${statCard('Add to cart', c.addToCart.toLocaleString(), `${c.attributedAddToCart} attributed`)}
        ${statCard('Conversion rate', pctFmt(c.conversionRate), 'sessions with a cart')}
        ${statCard('AOV', usd(c.aovUsd), 'per cart event')}
        ${statCard('ROI', roiMultiple(roi.roiMultiple), 'value ÷ cost')}
      </div>
      <p class="admin-insight-caveat admin-muted">⚠ ${esc(summary.caveat)}</p>
    </section>

    <section class="admin-card">
      <h3>Conversion funnel</h3>
      ${renderFunnel(funnel.funnel)}
    </section>

    <section class="admin-card">
      <h3>ROI model</h3>
      <div class="admin-insight-roi">
        <table class="admin-table admin-insight-table">
          <tbody>
            <tr><td>Attributed cart value × margin</td><td>${usd(roi.marginUsd)}</td></tr>
            <tr><td>Authoring effort avoided</td><td>${usd(roi.authoringSavedUsd)}</td></tr>
            <tr class="admin-insight-total"><td><strong>Total value</strong></td><td><strong>${usd(roi.totalValueUsd)}</strong></td></tr>
            <tr><td>Inference cost</td><td>−${usd(roi.costUsd)}</td></tr>
            <tr class="admin-insight-total"><td><strong>ROI multiple</strong></td><td><strong>${roiMultiple(roi.roiMultiple)}</strong></td></tr>
          </tbody>
        </table>
        <form class="admin-insight-assumptions" data-role="assumptions">
          <h4>Assumptions</h4>
          ${ROI_FIELDS.map(([key, label, step]) => `
            <label>${esc(label)}
              <input type="number" name="${key}" step="${step}" min="0"
                value="${esc(String(roi.assumptions[key]))}">
            </label>`).join('')}
          <button type="submit" class="admin-btn">Save assumptions</button>
          <span class="admin-muted" data-role="assumptions-status"></span>
        </form>
      </div>
    </section>

    <section class="admin-card">
      <h3>Cost vs. attributed value</h3>
      ${renderTimeseries(series.series)}
    </section>

    <section class="admin-card">
      <h3>By model</h3>
      <p class="admin-muted">Does the LLM judge score predict actual conversion?</p>
      ${renderModelsTable(models.models)}
    </section>

    <section class="admin-card">
      <h3>By segment</h3>
      ${renderSegmentTable('Query intent', segments.byIntent)}
      ${renderSegmentTable('Journey stage', segments.byJourneyStage)}
    </section>`;

  const form = body.querySelector('[data-role="assumptions"]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = form.querySelector('[data-role="assumptions-status"]');
    status.textContent = 'Saving…';
    const payload = {};
    ROI_FIELDS.forEach(([key]) => { payload[key] = Number(form.elements[key].value); });
    try {
      await api('/api/admin/insights/assumptions', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      status.textContent = 'Saved — reloading…';
      await renderInsights(root);
    } catch (err) {
      status.textContent = err.message;
    }
  });
}

// ── Entry ───────────────────────────────────────────────────────────────────

function syncHeaderNav(route) {
  const nav = document.querySelector('.admin-header-nav');
  if (!nav) return;
  const isVec = route.view?.startsWith('vec-');
  const isLlm = route.view === 'llm-config';
  const isExp = route.view === 'experiments' || route.view === 'experiment' || route.view === 'experiment-new';
  const isEval = route.view === 'evaluations' || route.view === 'evaluation' || route.view === 'evaluation-new';
  const isFb = route.view === 'feedback' || route.view === 'feedback-run';
  const isInsights = route.view === 'insights';
  nav.querySelectorAll('a[data-nav]').forEach((a) => {
    const key = a.dataset.nav;
    let active = false;
    if (key === 'vectorize') active = isVec;
    else if (key === 'llm-config') active = isLlm;
    else if (key === 'experiments') active = isExp;
    else if (key === 'evaluations') active = isEval;
    else if (key === 'feedback') active = isFb;
    else if (key === 'insights') active = isInsights;
    else if (key === 'sessions') active = !isVec && !isLlm && !isExp && !isEval && !isFb && !isInsights;
    a.classList.toggle('is-active', active);
  });
}

async function render(root) {
  const route = parseRoute();
  syncHeaderNav(route);
  if (route.view === 'session') {
    await renderSession(root, route.id);
  } else if (route.view === 'page') {
    await renderPage(root, route.id, route.tab);
  } else if (route.view === 'llm-config') {
    await renderLlmConfig(root);
  } else if (route.view === 'experiments') {
    await renderExperimentsList(root);
  } else if (route.view === 'experiment-new') {
    await renderExperimentCreateForm(root);
  } else if (route.view === 'experiment') {
    await renderExperiment(root, route.id, route.variantId);
  } else if (route.view === 'evaluations') {
    await renderEvaluationsList(root);
  } else if (route.view === 'evaluation-new') {
    await renderEvaluationCreateForm(root);
  } else if (route.view === 'evaluation') {
    await renderEvaluation(root, route.id);
  } else if (route.view === 'vec-overview') {
    await renderVectorizeOverview(root);
  } else if (route.view === 'vec-search') {
    await renderVectorizeSearch(root);
  } else if (route.view === 'vec-item') {
    await renderVectorizeItem(root, route.id);
  } else if (route.view === 'feedback') {
    await renderFeedbackList(root);
  } else if (route.view === 'feedback-run') {
    await renderFeedbackRun(root, route.id);
  } else if (route.view === 'insights') {
    await renderInsights(root);
  } else {
    await renderSessions(root);
  }
}

export default async function decorate(block) {
  block.innerHTML = '';
  const shell = document.createElement('div');
  shell.className = 'admin-shell';

  const header = document.createElement('header');
  header.className = 'admin-header';
  header.innerHTML = `
    <div class="admin-brand">⬡ <strong>Arco Admin</strong></div>
    <nav class="admin-header-nav">
      <a href="#/" data-nav="sessions">Sessions</a>
      <a href="#/experiments" data-nav="experiments">Experiments</a>
      <a href="#/evaluations" data-nav="evaluations">LLM Evaluation</a>
      <a href="#/feedback" data-nav="feedback">Feedback</a>
      <a href="#/insights" data-nav="insights">Insights</a>
      <a href="#/llm-config" data-nav="llm-config">Model Settings</a>
      <a href="#/vectorize" data-nav="vectorize">Vectorize</a>
    </nav>
    <div class="admin-header-actions">
      <button type="button" class="admin-btn admin-btn-ghost" data-action="reload">Reload</button>
      <button type="button" class="admin-btn admin-btn-ghost" data-action="logout">Reset token</button>
    </div>
  `;
  shell.appendChild(header);

  const view = document.createElement('div');
  view.className = 'admin-view';
  shell.appendChild(view);
  block.appendChild(shell);

  header.querySelector('[data-action="reload"]').addEventListener('click', () => {
    render(view);
  });
  header.querySelector('[data-action="logout"]').addEventListener('click', () => {
    clearAdminToken();
    render(view);
  });

  window.addEventListener('hashchange', () => { render(view); });
  await render(view);
}
