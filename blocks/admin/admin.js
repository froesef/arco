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

  if (hash === '/vectorize' || hash === '/vectorize/overview') return { view: 'vec-overview' };
  if (hash === '/vectorize/search' || hash.startsWith('/vectorize/search?')) return { view: 'vec-search' };

  const itemMatch = hash.match(/^\/vectorize\/items\/(.+)$/);
  if (itemMatch) return { view: 'vec-item', id: decodeURIComponent(itemMatch[1]) };

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
          <div class="admin-badges">${label}</div>
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
  } else {
    renderOverviewTab(panel, data);
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
          <select name="entry" required>
            ${catalog.map((e) => {
    const key = `${e.provider}::${e.model}`;
    const disabled = e.available === false ? ' disabled' : '';
    const missing = (e.missing || []).join(', ');
    const tag = e.available === false ? ` — needs ${missing}` : '';
    return `<option value="${esc(key)}"${currentKey === key ? ' selected' : ''}${disabled} title="${esc(e.available === false ? `Missing: ${missing}` : '')}">${esc(e.label)}${esc(tag)}</option>`;
  }).join('')}
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
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const [provider, model] = String(data.get('entry') || '').split('::');
    const body = {
      provider,
      model,
      temperature: Number(data.get('temperature')),
      maxTokens: Number(data.get('maxTokens')),
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

// ── Entry ───────────────────────────────────────────────────────────────────

function syncHeaderNav(route) {
  const nav = document.querySelector('.admin-header-nav');
  if (!nav) return;
  const isVec = route.view?.startsWith('vec-');
  const isLlm = route.view === 'llm-config';
  nav.querySelectorAll('a[data-nav]').forEach((a) => {
    const key = a.dataset.nav;
    let active = false;
    if (key === 'vectorize') active = isVec;
    else if (key === 'llm-config') active = isLlm;
    else if (key === 'sessions') active = !isVec && !isLlm;
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
  } else if (route.view === 'vec-overview') {
    await renderVectorizeOverview(root);
  } else if (route.view === 'vec-search') {
    await renderVectorizeSearch(root);
  } else if (route.view === 'vec-item') {
    await renderVectorizeItem(root, route.id);
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
