/**
 * Debug Panel Block
 *
 * Renders a collapsible accordion panel showing full pipeline diagnostics
 * for the AI recommender. Activated by ?debug=true in the URL.
 *
 * Data is passed via block.dataset.debugInfo (JSON).
 */

import { formatDuration, timingClass } from '../../scripts/formatting.js';

const formatMs = (ms) => formatDuration(ms, 2);

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function copyButton(label, text) {
  const btn = document.createElement('button');
  btn.className = 'debug-panel-copy';
  btn.textContent = label;
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(text).then(() => {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    }).catch(() => {});
  });
  return btn;
}

function makeAccordion(title, contentEl, defaultOpen = false) {
  const item = document.createElement('div');
  item.className = 'debug-accordion-item';

  const header = document.createElement('button');
  header.className = 'debug-accordion-header';
  header.setAttribute('aria-expanded', defaultOpen ? 'true' : 'false');
  header.innerHTML = `<span class="debug-accordion-chevron"></span><span>${escapeHtml(title)}</span>`;

  const body = document.createElement('div');
  body.className = 'debug-accordion-body';
  if (!defaultOpen) body.setAttribute('hidden', '');
  body.appendChild(contentEl);

  header.addEventListener('click', () => {
    const isOpen = header.getAttribute('aria-expanded') === 'true';
    header.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
    if (isOpen) body.setAttribute('hidden', '');
    else body.removeAttribute('hidden');
  });

  item.appendChild(header);
  item.appendChild(body);
  return item;
}

function renderOverview(d) {
  const el = document.createElement('div');
  el.className = 'debug-overview';

  const providerModel = d.llm?.provider
    ? `${escapeHtml(d.llm.provider)} / ${escapeHtml(d.llm?.model || '—')}`
    : escapeHtml(d.llm?.model);
  const rows = [
    ['Total Time', `<span class="debug-badge ${timingClass(d.timings?.total)}">${formatMs(d.timings?.total)}</span>`],
    ['Provider / Model', providerModel],
    ['Temperature', d.llm?.temperature != null ? escapeHtml(String(d.llm.temperature)) : '—'],
    ['Max Tokens', d.llm?.maxTokens != null ? escapeHtml(String(d.llm.maxTokens)) : '—'],
    ['Flow', escapeHtml(d.pipeline?.flowName || d.pipeline?.flow)],
    ['Intent', d.intent ? `${escapeHtml(d.intent.type)} <span class="debug-dim">(${Math.round((d.intent.confidence || 0) * 100)}% conf)</span>` : '—'],
    ['Journey Stage', escapeHtml(d.intent?.journeyStage)],
    ['LLM Time', `<span class="debug-badge ${timingClass(d.timings?.llm)}">${formatMs(d.timings?.llm)}</span>`],
    ['First Token', formatMs(d.timings?.llmFirstToken)],
    ['Tokens In / Out', d.llm?.inputTokens != null ? `${d.llm.inputTokens} / ${d.llm.outputTokens}` : '—'],
    ['Total Tokens', d.llm?.totalTokens ?? '—'],
    ['Output Chars', d.llm?.outputLength ?? '—'],
    ['Sections', d.llm?.sections ?? '—'],
  ];

  el.innerHTML = rows.map(([label, val]) => `
    <div class="debug-row">
      <span class="debug-label">${escapeHtml(label)}</span>
      <span class="debug-value">${val}</span>
    </div>`).join('');

  return el;
}

function renderPipelineSteps(steps) {
  const el = document.createElement('div');
  if (!steps?.length) { el.textContent = 'No step data.'; return el; }

  el.innerHTML = steps.map((s) => `
    <div class="debug-row">
      <span class="debug-label">${escapeHtml(s.step)}${s.gate ? ' <span class="debug-tag">gate</span>' : ''}</span>
      <span class="debug-badge ${timingClass(s.ms)}">${formatMs(s.ms)}</span>
    </div>`).join('');

  return el;
}

function renderRagResults(rag) {
  const el = document.createElement('div');
  if (!rag) { el.textContent = 'No RAG data.'; return el; }

  const sections = [
    {
      label: `Products (${rag.products?.count ?? 0})`,
      items: rag.products?.items?.map((p) => `${escapeHtml(p.name)} <span class="debug-dim">${escapeHtml(p.id)} · score ${p.score?.toFixed(2) ?? '?'} · $${escapeHtml(p.price)}</span>`),
    },
    {
      label: 'Persona',
      items: rag.persona?.name ? [escapeHtml(rag.persona.name)] : [],
    },
    {
      label: 'Use Case',
      items: rag.useCase?.name ? [escapeHtml(rag.useCase.name)] : [],
    },
    {
      label: `Features (${rag.features?.count ?? 0})`,
      items: rag.features?.items?.map((f) => `${escapeHtml(f.name)}: <span class="debug-dim">${escapeHtml(f.benefit)}</span>`),
    },
    {
      label: `FAQs (${rag.faqs?.count ?? 0})`,
      items: rag.faqs?.items?.map((f) => escapeHtml(f.question)),
    },
    {
      label: `Reviews (${rag.reviews?.count ?? 0})`,
      items: rag.reviews?.items?.map((r) => `${escapeHtml(r.author)} · <span class="debug-dim">${escapeHtml(r.product)}</span>`),
    },
    {
      label: `Guides (${rag.guides?.count ?? 0})`,
      items: rag.guides?.items?.map((g) => `${escapeHtml(g.title)} <span class="debug-dim">${escapeHtml(g.slug ?? '')} · score ${g.score?.toFixed(2) ?? '?'}</span>`),
    },
    {
      label: `Experiences (${rag.experiences?.count ?? 0})`,
      items: rag.experiences?.items?.map((e) => `${escapeHtml(e.title)} <span class="debug-dim">${escapeHtml(e.slug ?? '')} · score ${e.score?.toFixed(2) ?? '?'}</span>`),
    },
    {
      label: `Comparisons (${rag.comparisons?.count ?? 0})`,
      items: rag.comparisons?.items?.map((c) => `${escapeHtml(c.title)} <span class="debug-dim">${escapeHtml(c.source ?? 'vector')}</span>`),
    },
    {
      label: `Tools (${rag.tools?.count ?? 0})`,
      items: rag.tools?.items?.map((t) => `${escapeHtml(t.title)} <span class="debug-dim">score ${t.score?.toFixed(2) ?? '?'}</span>`),
    },
    {
      label: `Hero Images (${rag.heroImages?.count ?? 0})`,
      items: rag.heroImages?.items?.map((h) => `${escapeHtml(h.id ?? '?')} <span class="debug-dim">${escapeHtml(h.category ?? '')} · score ${h.score?.toFixed(2) ?? '?'}</span>`),
    },
    {
      label: `Recipes (${rag.recipes?.count ?? 0})`,
      items: rag.recipes?.items?.map((r) => `${escapeHtml(r.name)} <span class="debug-dim">score ${r.score?.toFixed(2) ?? '?'}</span>`),
    },
  ];

  sections.forEach(({ label, items }) => {
    const group = document.createElement('div');
    group.className = 'debug-rag-group';
    group.innerHTML = `<div class="debug-rag-label">${label}</div>`;
    if (items?.length) {
      const list = document.createElement('ul');
      list.className = 'debug-rag-list';
      list.innerHTML = items.map((i) => `<li>${i}</li>`).join('');
      group.appendChild(list);
    } else {
      const none = document.createElement('span');
      none.className = 'debug-dim';
      none.textContent = 'none';
      group.appendChild(none);
    }
    el.appendChild(group);
  });

  return el;
}

function renderBehaviorAnalysis(ba) {
  const el = document.createElement('div');
  if (!ba) { el.textContent = 'No behavior analysis.'; return el; }

  const rows = [
    ['Cold Start', ba.coldStart ? 'Yes' : 'No'],
    ['Price Tier', ba.priceTier ?? '—'],
    ['Journey Stage', ba.journeyStage ?? '—'],
    ['Purchase Readiness', ba.purchaseReadiness ?? '—'],
    ['Inferred Intent', ba.inferredIntent ?? '—'],
    ['Use Case Priorities', (ba.useCasePriorities || []).join(', ') || '—'],
    ['Products Viewed', (ba.productsViewed || []).join(', ') || '—'],
    ['Product Shortlist', (ba.productShortlist || []).join(', ') || '—'],
  ];

  el.innerHTML = rows.map(([label, val]) => `
    <div class="debug-row">
      <span class="debug-label">${escapeHtml(label)}</span>
      <span class="debug-value">${escapeHtml(val)}</span>
    </div>`).join('');

  return el;
}

function renderSessionContext(ctx) {
  const el = document.createElement('div');
  if (!ctx) { el.textContent = 'No session context.'; return el; }

  const prevQueries = ctx.previousQueries || [];
  const browsingHist = ctx.browsingHistory || [];
  const shownContent = ctx.shownContent || {};

  if (prevQueries.length) {
    const group = document.createElement('div');
    group.className = 'debug-rag-group';
    group.innerHTML = `<div class="debug-rag-label">Previous Queries (${prevQueries.length})</div>`;
    const list = document.createElement('ul');
    list.className = 'debug-rag-list';
    list.innerHTML = prevQueries.map((q) => `<li>${escapeHtml(q.query)} <span class="debug-dim">${escapeHtml(q.intent || '')} · ${escapeHtml(q.journeyStage || '')}</span></li>`).join('');
    group.appendChild(list);
    el.appendChild(group);
  }

  if (ctx.quizPersona) {
    const group = document.createElement('div');
    group.className = 'debug-rag-group';
    group.innerHTML = `<div class="debug-rag-label">Quiz Persona</div><span>${escapeHtml(ctx.quizPersona)}</span>`;
    el.appendChild(group);
  }

  if (browsingHist.length) {
    const group = document.createElement('div');
    group.className = 'debug-rag-group';
    group.innerHTML = `<div class="debug-rag-label">Browsing History (${browsingHist.length})</div>`;
    const list = document.createElement('ul');
    list.className = 'debug-rag-list';
    list.innerHTML = browsingHist.map((h) => `<li>${escapeHtml(h.path)} <span class="debug-dim">${escapeHtml(h.intent || '')} · ${escapeHtml(h.stage || '')} · ${Math.round((h.timeSpent || 0) / 1000)}s</span></li>`).join('');
    group.appendChild(list);
    el.appendChild(group);
  }

  if (ctx.inferredProfile) {
    const group = document.createElement('div');
    group.className = 'debug-rag-group';
    group.innerHTML = '<div class="debug-rag-label">Inferred Profile</div>';
    const pre = document.createElement('pre');
    pre.className = 'debug-pre debug-pre-sm';
    pre.textContent = JSON.stringify(ctx.inferredProfile, null, 2);
    group.appendChild(pre);
    el.appendChild(group);
  }

  const shownProducts = shownContent.shownProducts || [];
  if (shownProducts.length) {
    const group = document.createElement('div');
    group.className = 'debug-rag-group';
    group.innerHTML = `<div class="debug-rag-label">Shown Products</div><span>${shownProducts.map(escapeHtml).join(', ')}</span>`;
    el.appendChild(group);
  }

  if (!el.children.length) {
    el.textContent = 'Empty session (cold start).';
  }

  return el;
}

function renderPrompt(label, text) {
  const el = document.createElement('div');
  el.className = 'debug-prompt-block';

  const meta = document.createElement('div');
  meta.className = 'debug-prompt-meta';
  meta.innerHTML = `<span class="debug-dim">${escapeHtml(label)} · ${(text || '').length.toLocaleString()} chars</span>`;
  el.appendChild(meta);
  el.appendChild(copyButton('Copy', text || ''));

  const pre = document.createElement('pre');
  pre.className = 'debug-pre';
  pre.textContent = text || '(empty)';
  el.appendChild(pre);

  return el;
}

function renderSectionDetails(details) {
  const el = document.createElement('div');
  if (!details?.length) { el.textContent = 'No section details.'; return el; }

  details.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'debug-section-card';

    const header = document.createElement('div');
    header.className = 'debug-section-header';
    header.innerHTML = `
      <span class="debug-section-block">${escapeHtml(s.block)}</span>
      ${(s.variants || []).map((v) => `<span class="debug-tag">${escapeHtml(v)}</span>`).join('')}
      <span class="debug-badge ${timingClass(s.totalMs)}">${formatMs(s.totalMs)}</span>`;
    card.appendChild(header);

    const rows = [
      ['JSON→HTML', formatMs(s.jsonToHtmlMs)],
      ['Token Resolve', formatMs(s.resolveTokensMs)],
      ['URL Normalize', formatMs(s.normalizeUrlsMs)],
      ['Sanitize', formatMs(s.sanitizeMs)],
    ];
    const rowEl = document.createElement('div');
    rowEl.className = 'debug-section-rows';
    rowEl.innerHTML = rows.map(([label, val]) => `
      <div class="debug-row debug-row-sm">
        <span class="debug-label">${escapeHtml(label)}</span>
        <span class="debug-value">${escapeHtml(val)}</span>
      </div>`).join('');
    card.appendChild(rowEl);

    if (s.tokens?.found?.length || s.tokens?.failed?.length) {
      const tokenInfo = document.createElement('div');
      tokenInfo.className = 'debug-dim debug-row-sm';
      tokenInfo.textContent = `Tokens: ${s.tokens.found?.length ?? 0} found, ${s.tokens.failed?.length ?? 0} failed`;
      card.appendChild(tokenInfo);
    }

    if (s.urlChanges?.length) {
      const urlInfo = document.createElement('div');
      urlInfo.className = 'debug-dim debug-row-sm';
      urlInfo.textContent = `URL changes: ${s.urlChanges.length}`;
      card.appendChild(urlInfo);
    }

    el.appendChild(card);
  });

  return el;
}

function renderLlmOutput(llm) {
  const el = document.createElement('div');
  if (!llm) { el.textContent = 'No LLM data.'; return el; }

  const meta = document.createElement('div');
  meta.className = 'debug-prompt-meta';
  meta.innerHTML = `<span class="debug-dim">${(llm.rawOutput || '').length.toLocaleString()} chars · ${llm.chunks ?? '?'} chunks</span>`;
  el.appendChild(meta);
  el.appendChild(copyButton('Copy Raw Output', llm.rawOutput || ''));

  const pre = document.createElement('pre');
  pre.className = 'debug-pre';
  pre.textContent = llm.rawOutput || '(empty)';
  el.appendChild(pre);

  return el;
}

export default function decorate(block) {
  let info;
  try {
    info = JSON.parse(block.dataset.debugInfo || '{}');
  } catch {
    block.textContent = 'Debug data unavailable.';
    return;
  }

  block.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'debug-panel-header';
  header.innerHTML = `
    <span class="debug-panel-title">Debug Mode</span>
    <span class="debug-panel-subtitle">${escapeHtml(info.pipeline?.flowName || info.pipeline?.flow || 'recommender')} · ${formatMs(info.timings?.total)}</span>`;

  const expandBtn = document.createElement('button');
  expandBtn.className = 'debug-panel-expand-all';
  expandBtn.textContent = 'Expand All';
  header.appendChild(expandBtn);
  block.appendChild(header);

  const accordion = document.createElement('div');
  accordion.className = 'debug-accordion';

  accordion.appendChild(makeAccordion('Overview', renderOverview(info), true));
  accordion.appendChild(makeAccordion('Session Context', renderSessionContext(info.sessionContext)));
  accordion.appendChild(makeAccordion('Behavior Analysis', renderBehaviorAnalysis(info.behaviorAnalysis)));
  accordion.appendChild(makeAccordion(`Pipeline Steps (${info.timings?.steps?.length ?? 0})`, renderPipelineSteps(info.timings?.steps)));
  accordion.appendChild(makeAccordion('RAG Results', renderRagResults(info.rag)));
  accordion.appendChild(makeAccordion('System Prompt', renderPrompt('System', info.prompt?.systemPrompt)));
  accordion.appendChild(makeAccordion('User Message', renderPrompt('User', info.prompt?.userMessage)));
  accordion.appendChild(makeAccordion('LLM Raw Output', renderLlmOutput(info.llm)));
  accordion.appendChild(makeAccordion(`Section Details (${info.sectionDetails?.length ?? 0})`, renderSectionDetails(info.sectionDetails)));

  block.appendChild(accordion);

  expandBtn.addEventListener('click', () => {
    const allHeaders = accordion.querySelectorAll('.debug-accordion-header');
    const allExpanded = [...allHeaders].every((h) => h.getAttribute('aria-expanded') === 'true');
    allHeaders.forEach((h) => {
      const body = h.nextElementSibling;
      if (allExpanded) {
        h.setAttribute('aria-expanded', 'false');
        body.setAttribute('hidden', '');
      } else {
        h.setAttribute('aria-expanded', 'true');
        body.removeAttribute('hidden');
      }
    });
    expandBtn.textContent = allExpanded ? 'Expand All' : 'Collapse All';
  });
}
