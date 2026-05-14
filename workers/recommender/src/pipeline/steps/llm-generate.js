/**
 * LLM Generate Step — streams AI content via the selected provider, parses
 * sections incrementally, token-resolves/sanitizes each section.
 *
 * Two entry points:
 *   llmGenerate(ctx, config, env)
 *     The flow step. Writes to ctx.llm.* and ctx.timings.*. Emits untagged
 *     NDJSON events on ctx.writer — contract with /api/generate is byte-identical
 *     to before the runLlmVariant extraction.
 *
 *   runLlmVariant(ctx, env, opts)
 *     Reusable primitive for both the single-run path (called from llmGenerate)
 *     and the admin experiments fan-out path. When opts.variantId is set, every
 *     NDJSON event is tagged with that variantId so a shared stream can carry
 *     multiple concurrent variants. Writes into opts.out / opts.timings so each
 *     caller can keep a private state bag.
 */

import { getProvider, findCatalogEntry, catalogAvailability } from '../../providers/index.js';
import { getActiveLlmConfig, resolveLlmConfig } from '../../llm-config.js';
import { writeEvent } from '../../analytics.js';
import { sectionToHtml, sanitizeBlockContent } from '../../json-to-eds.js';
import {
  resolveTokens, normalizeProductUrls, getProductData, setHeroResult,
  sanitizeContentCards,
} from '../../images.js';
import { selectHeroImage } from '../../hero-images.js';
import { extractProductIds } from '../../context.js';
import sanitizeHTML from '../../sanitize.js';
import { StreamParser } from '../../stream-parser.js';
import { unescapeHtml } from '../../da-persist.js';

/**
 * Process a completed JSON section: convert to HTML, resolve tokens, sanitize.
 *
 * Two block-level filters run first, in order:
 *   1. sanitizeBlockContent — rejects sections whose content is structurally
 *      empty (e.g. testimonials with no real quotes).
 *   2. sanitizeContentCards — on article-excerpt/blog-card/experience-cta,
 *      drops rows whose slug or href isn't in the bundled stories/experiences
 *      indices, so invented links never reach the DOM.
 * Returns '' when either filter rejects the section, letting the hasContent()
 * caller skip it naturally.
 */
export function processSection(section) {
  const cleaned = sanitizeBlockContent(section);
  if (!cleaned) return '';
  const cardClean = sanitizeContentCards(cleaned);
  if (Array.isArray(cardClean?.rows)
      && cardClean.rows.length === 0
      && cleaned?.rows?.length > 0) {
    return '';
  }
  let html = sectionToHtml(cardClean);
  html = resolveTokens(html);
  html = normalizeProductUrls(html);
  html = sanitizeHTML(html);
  return html;
}

/**
 * Extract all href attribute values from HTML, in order.
 */
function extractHrefs(html) {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
}

/**
 * Extract all {{type:value}} content tokens from HTML.
 */
function extractContentTokens(html) {
  return [...html.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[0]);
}

/**
 * Extract failed token resolution comments (<!-- unknown ..., <!-- product unavailable ...).
 */
function extractFailedComments(html) {
  return [...html.matchAll(/<!--\s*(?:unknown|product unavailable)\s+[\s\S]*?-->/g)]
    .map((m) => m[0].trim());
}

/**
 * Process a section with full debug tracking of each sub-step.
 */
export function processSectionDetailed(section) {
  const debug = {};

  const cleaned = sanitizeBlockContent(section);
  if (!cleaned) {
    debug.skipped = 'empty-block-content';
    return { html: '', debug };
  }

  const originalRowCount = Array.isArray(cleaned.rows) ? cleaned.rows.length : 0;
  const cardClean = sanitizeContentCards(cleaned);
  const cleanRowCount = Array.isArray(cardClean?.rows) ? cardClean.rows.length : 0;
  debug.cardRowsDropped = originalRowCount - cleanRowCount;
  if (originalRowCount > 0 && cleanRowCount === 0
      && (cardClean.block === 'article-excerpt'
        || cardClean.block === 'blog-card'
        || cardClean.block === 'experience-cta')) {
    debug.droppedEmptyCardBlock = true;
    return { html: '', debug };
  }

  let t = Date.now();
  let html = sectionToHtml(cardClean);
  debug.jsonToHtmlMs = Date.now() - t;
  const hrefsAfterJson = extractHrefs(html);
  const tokensFound = extractContentTokens(html);

  t = Date.now();
  html = resolveTokens(html);
  debug.resolveTokensMs = Date.now() - t;
  const hrefsAfterTokens = extractHrefs(html);
  const failedComments = extractFailedComments(html);
  const unresolvedTokens = extractContentTokens(html);

  debug.tokens = {
    found: tokensFound,
    resolvedCount: tokensFound.length - failedComments.length - unresolvedTokens.length,
    failed: failedComments,
    unresolved: unresolvedTokens,
  };

  t = Date.now();
  html = normalizeProductUrls(html);
  debug.normalizeUrlsMs = Date.now() - t;
  const hrefsAfterNorm = extractHrefs(html);

  const urlChanges = [];
  for (let i = 0; i < Math.max(hrefsAfterTokens.length, hrefsAfterNorm.length); i += 1) {
    if (hrefsAfterTokens[i] !== hrefsAfterNorm[i]) {
      urlChanges.push({ from: hrefsAfterTokens[i] || null, to: hrefsAfterNorm[i] || null });
    }
  }
  debug.urlChanges = urlChanges;

  debug.links = {
    afterJsonToHtml: hrefsAfterJson,
    afterResolveTokens: hrefsAfterTokens,
    afterNormalizeUrls: hrefsAfterNorm,
  };

  const preSanitize = html;
  t = Date.now();
  html = sanitizeHTML(html);
  debug.sanitizeMs = Date.now() - t;
  debug.sanitizeChanged = html !== preSanitize;
  debug.links.final = extractHrefs(html);

  debug.totalMs = debug.jsonToHtmlMs + debug.resolveTokensMs
    + debug.normalizeUrlsMs + debug.sanitizeMs;

  return { html, debug };
}

function hasContent(html) {
  return html.replace(/<[^>]*>/g, '').trim().length > 0;
}

function createFallbackHeroSection(query) {
  const rawTitle = (query || '').trim().replace(/\?+$/, '');
  const title = rawTitle
    ? rawTitle.charAt(0).toUpperCase() + rawTitle.slice(1)
    : 'Find Your Perfect Espresso Setup';
  return {
    block: 'hero',
    rows: [[
      [{ type: 'image', token: '{{hero-image:main}}' }],
      [
        { type: 'p', text: 'Personalized For You' },
        { type: 'h1', text: title },
        { type: 'p', text: 'Here are our best recommendations based on your preferences.' },
      ],
    ]],
  };
}

// Only 'explore' and 'compare' may come from the LLM. The 'buy' CTA is injected
// server-side post-parse against a product the LLM picked.
const LLM_SUGGESTION_TYPES = ['explore', 'compare'];

function extractPrimaryProduct(rawJsonSections) {
  const imageTokenRe = /\{\{product-image:([^}]+)\}\}/;

  const colBlock = rawJsonSections.find(
    (s) => s.block === 'columns' && JSON.stringify(s).includes('{{product-image:'),
  );
  if (colBlock) {
    const match = JSON.stringify(colBlock).match(imageTokenRe);
    if (match) {
      const data = getProductData(match[1].trim());
      if (data) return { id: data.id, name: data.name, url: data.url };
    }
  }

  const cmpBlock = rawJsonSections.find(
    (s) => s.block === 'comparison-table' && s.data?.recommended,
  );
  if (cmpBlock) {
    const recName = cmpBlock.data.recommended.toLowerCase().replace(/^vitamix\s+/i, '');
    const json = JSON.stringify(cmpBlock);
    const allIds = Array.from(json.matchAll(/\{\{product-image:([^}]+)\}\}/g))
      .map((m) => m[1].trim());

    const matched = allIds.reduce((found, id) => {
      if (found) return found;
      const data = getProductData(id);
      return (data && data.name.toLowerCase().includes(recName)) ? data : null;
    }, null);
    if (matched) return { id: matched.id, name: matched.name, url: matched.url };

    const fallback = allIds.reduce((found, id) => {
      if (found) return found;
      return getProductData(id);
    }, null);
    if (fallback) return { id: fallback.id, name: fallback.name, url: fallback.url };
  }

  return null;
}

export function processSuggestions(suggestions) {
  if (!Array.isArray(suggestions)) return [];
  return suggestions.filter(
    (s) => s && s.label && LLM_SUGGESTION_TYPES.includes(s.type)
      && !/^(try |view |read |check out |browse |shop )/i.test(s.label),
  );
}

export function extractTitle(firstSection) {
  const h1Match = firstSection.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1Match) return unescapeHtml(h1Match[1]);
  const h2Match = firstSection.match(/<h2[^>]*>([^<]+)<\/h2>/i);
  if (h2Match) return unescapeHtml(h2Match[1]);
  return '';
}

/**
 * Dummy LLM bypass — streams pre-canned content without calling the provider.
 * Activated by the X-Skip-Cerebras request header (load testing only).
 */
async function streamDummyContent(ctx) {
  const query = ctx.request?.query || 'your query';
  const dummySections = [
    `<div class="section"><h1>Results for: ${query}</h1><p>This is dummy content returned by the load test bypass. No LLM was called.</p></div>`,
    '<div class="section"><h2>About this product</h2><p>The Arco Studio Pro is an excellent espresso machine designed for home baristas who demand precision and consistency in every shot.</p></div>',
    '<div class="section"><h2>Key features</h2><ul><li>PID temperature control</li><li>58mm portafilter</li><li>Built-in pressure gauge</li></ul></div>',
  ];

  ctx.timings.llmStart = Date.now();
  ctx.timings.llmFirstToken = Date.now();

  for (let i = 0; i < dummySections.length; i += 1) {
    const html = dummySections[i];
    ctx.llm.sections.push(html);
    const line = JSON.stringify({ type: 'section', index: i, html });
    ctx.ndjsonLines.push(line);
    // eslint-disable-next-line no-await-in-loop
    await ctx.writer.write(ctx.encoder.encode(`${line}\n`));
  }

  ctx.timings.llmLastToken = Date.now();
  ctx.timings.llmEnd = Date.now();

  const suggestions = [
    { type: 'explore', label: 'Compare espresso machines' },
    { type: 'explore', label: 'Best grinders for espresso' },
  ];
  ctx.llm.suggestions = suggestions;
  const sugLine = JSON.stringify({ type: 'suggestions', items: suggestions });
  ctx.ndjsonLines.push(sugLine);
  await ctx.writer.write(ctx.encoder.encode(`${sugLine}\n`));

  const debugLine = JSON.stringify({
    type: 'debug',
    timings: {
      total: Date.now() - ctx.timings.start,
      llm: ctx.timings.llmEnd - ctx.timings.llmStart,
      dummy: true,
    },
    pipeline: { flow: ctx.flowId || 'default', dummy: true },
  });
  ctx.ndjsonLines.push(debugLine);
  await ctx.writer.write(ctx.encoder.encode(`${debugLine}\n`));

  const doneLine = JSON.stringify({ type: 'done', title: `Results for: ${query}`, usedProducts: [] });
  ctx.ndjsonLines.push(doneLine);
  await ctx.writer.write(ctx.encoder.encode(`${doneLine}\n`));
}

/**
 * Create a fresh per-variant state bag matching ctx.llm's shape.
 * Used by the admin experiments fan-out so each variant accumulates
 * sections / suggestions / usage / fullText in isolation.
 */
export function createVariantState() {
  return {
    fullText: '',
    sections: [],
    rawJsonSections: [],
    suggestions: [],
    usage: null,
    provider: null,
    model: null,
    temperature: null,
    maxTokens: null,
  };
}

/**
 * Run one LLM variant end-to-end. Returns when the stream closes.
 *
 * @param {object} ctx Pipeline context (shared upstream RAG/prompt).
 * @param {object} env Worker env (bindings + secrets).
 * @param {object} opts
 *   - variantId?: string   When set, all NDJSON events get a `variantId` field
 *                          (so the same writer can carry concurrent variants).
 *                          When null/undefined, events are untagged — byte-
 *                          identical to the legacy /api/generate contract.
 *   - provider: string     Provider id ('cerebras' | 'cloudflare' | 'sambanova').
 *   - model: string
 *   - temperature: number
 *   - maxTokens: number
 *   - out?: object         State bag to populate (default: ctx.llm).
 *   - timings?: object     Timings bag (default: ctx.timings).
 *   - emitDebug?: boolean  Whether to emit the big `type: 'debug'` NDJSON line
 *                          (default: true — matches legacy behaviour).
 *   - emitDone?: boolean   Whether to emit the terminal `type: 'done'` line
 *                          (default: true).
 *   - llmTimeoutMs?: number
 */
export async function runLlmVariant(ctx, env, opts) {
  const {
    variantId = null,
    provider: providerId,
    model,
    temperature,
    maxTokens,
    out = ctx.llm,
    timings = ctx.timings,
    emitDebug = true,
    emitDone = true,
    llmTimeoutMs,
  } = opts;

  // Preflight — surface a helpful error instead of letting the vendor call fail.
  const entry = findCatalogEntry(providerId, model)
    || { provider: providerId, model };
  const { available, missing } = catalogAvailability(entry, env);
  if (!available) {
    const err = new Error(`Missing configuration for ${providerId}/${model}: ${missing.join(', ')}. Set the required secrets or pick a different model in Admin → Model Settings.`);
    err.status = 400;
    throw err;
  }

  const provider = getProvider(providerId);
  out.model = model;
  out.provider = providerId;
  out.temperature = temperature;
  out.maxTokens = maxTokens;

  const tagged = variantId != null;
  const writeLine = async (obj) => {
    const line = JSON.stringify(tagged ? { ...obj, variantId } : obj);
    // Untagged path preserves the legacy NDJSON replay buffer on ctx.
    if (!tagged) ctx.ndjsonLines.push(line);
    await ctx.writer.write(ctx.encoder.encode(`${line}\n`));
  };

  // Heartbeat keeps the connection alive while waiting for the first token.
  const heartbeatInterval = setInterval(async () => {
    try {
      await ctx.writer.write(
        ctx.encoder.encode(`${JSON.stringify(tagged ? { type: 'heartbeat', variantId } : { type: 'heartbeat' })}\n`),
      );
    } catch {
      clearInterval(heartbeatInterval);
    }
  }, 3000);

  const timeoutMs = llmTimeoutMs || 60_000;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  timings.llmStart = Date.now();
  let completion;
  try {
    completion = provider.stream({
      env,
      model,
      messages: [
        { role: 'system', content: ctx.prompt.system },
        { role: 'user', content: ctx.prompt.user },
      ],
      maxTokens,
      temperature,
      signal: abortController.signal,
    });
  } catch (llmErr) {
    clearTimeout(timeoutId);
    clearInterval(heartbeatInterval);
    if (llmErr.name === 'AbortError' || abortController.signal.aborted) {
      throw new Error('AI request timed out. Try a simpler query.');
    }
    const status = llmErr.status || llmErr.statusCode;
    let msg = 'AI service unavailable. Please try again.';
    if (status === 401) msg = 'AI authentication failed. Check API key.';
    else if (status === 429) msg = 'AI rate limit reached. Please wait a moment.';
    else if (status === 503 || status === 502) msg = 'AI service is temporarily overloaded. Try again shortly.';
    else if (llmErr.message?.includes('timeout')) msg = 'AI request timed out. Try a simpler query.';
    throw new Error(msg);
  }

  const parser = new StreamParser();
  const sectionTimings = [];
  const sectionDetails = [];
  let sectionIndex = 0;
  let tokenCount = 0;
  // Follow-up turns already have a hero from the first generation — skip injecting one.
  let heroEnsured = !!ctx.request.followUp;

  try {
    // eslint-disable-next-line no-restricted-syntax
    for await (const chunk of completion) {
      if (chunk.type === 'usage') {
        out.usage = chunk.usage;
        continue; // eslint-disable-line no-continue
      }
      const content = chunk.type === 'delta' ? chunk.text : null;
      if (content) {
        if (!timings.llmFirstToken) timings.llmFirstToken = Date.now();
        timings.llmLastToken = Date.now();
        out.fullText += content;
        tokenCount += 1;

        const completedSections = parser.feed(content);
        // eslint-disable-next-line no-restricted-syntax
        for (const section of completedSections) {
          const { html, debug: sDebug } = processSectionDetailed(section);
          if (!hasContent(html)) continue; // eslint-disable-line no-continue

          if (!heroEnsured) {
            heroEnsured = true;
            if (section.block !== 'hero') {
              const heroHtml = processSection(createFallbackHeroSection(ctx.request?.query));
              if (hasContent(heroHtml)) {
                // eslint-disable-next-line no-await-in-loop
                await writeLine({ type: 'section', index: sectionIndex, html: heroHtml });
                sectionIndex += 1;
              }
            }
          }

          out.rawJsonSections.push(section);
          out.sections.push(html);
          sectionTimings.push(sDebug.totalMs);
          sectionDetails.push({
            index: sectionIndex,
            block: section.block,
            variants: section.variants || [],
            ...sDebug,
          });

          // eslint-disable-next-line no-await-in-loop
          await writeLine({ type: 'section', index: sectionIndex, html });
          sectionIndex += 1;
        }
      }
    }
  } catch (streamErr) {
    if (streamErr.name === 'AbortError' || abortController.signal.aborted) {
      throw new Error('AI request timed out. Try a simpler query.');
    }
    throw streamErr;
  } finally {
    clearTimeout(timeoutId);
    clearInterval(heartbeatInterval);
  }

  timings.llmEnd = Date.now();

  // Finalize: process trailing buffer (last section + suggestions).
  timings.parseStart = Date.now();
  const final = parser.finalize();

  if (final.section) {
    const { html, debug: sDebug } = processSectionDetailed(final.section);
    if (hasContent(html)) {
      if (!heroEnsured) {
        heroEnsured = true;
        if (final.section.block !== 'hero') {
          const heroHtml = processSection(createFallbackHeroSection(ctx.request?.query));
          if (hasContent(heroHtml)) {
            await writeLine({ type: 'section', index: sectionIndex, html: heroHtml });
            sectionIndex += 1;
          }
        }
      }

      out.rawJsonSections.push(final.section);
      out.sections.push(html);
      sectionTimings.push(sDebug.totalMs);
      sectionDetails.push({
        index: sectionIndex,
        block: final.section.block,
        variants: final.section.variants || [],
        ...sDebug,
      });

      await writeLine({ type: 'section', index: sectionIndex, html });
      sectionIndex += 1;
    }
  }

  if (final.suggestions) {
    out.suggestions = processSuggestions(final.suggestions);
    const primary = extractPrimaryProduct(out.rawJsonSections);
    if (primary) {
      out.suggestions.unshift({
        type: 'buy',
        label: `Buy ${primary.name}`,
        query: primary.id,
        href: primary.url,
      });
    }
  }
  timings.parseEnd = Date.now();

  if (out.suggestions.length) {
    await writeLine({ type: 'suggestions', items: out.suggestions });
  }

  if (emitDebug) {
    const contextTime = (ctx.timings.steps || [])
      .filter((s) => !s.gate)
      .reduce((sum, s) => sum + s.ms, 0);

    await writeLine({
      type: 'debug',
      timings: {
        total: Date.now() - ctx.timings.start,
        context: contextTime,
        prompt: ctx.timings.prompt || 0,
        llm: timings.llmEnd - timings.llmStart,
        llmFirstToken: timings.llmFirstToken
          ? timings.llmFirstToken - timings.llmStart : null,
        llmLastToken: timings.llmLastToken
          ? timings.llmLastToken - timings.llmStart : null,
        llmStreaming: (timings.llmFirstToken && timings.llmLastToken)
          ? timings.llmLastToken - timings.llmFirstToken : null,
        parse: timings.parseEnd - timings.parseStart,
        sectionProcessing: sectionTimings,
        steps: ctx.timings.steps || [],
      },
      pipeline: {
        flow: ctx.flowId || 'default',
        flowName: ctx.flowName || ctx.flowId || 'default',
      },
      behaviorAnalysis: ctx.rag.behaviorAnalysis || null,
      rag: {
        recipes: {
          count: ctx.rag.recipes?.length || 0,
          ms: ctx.timings.recipes || 0,
          detail: ctx.timings.recipesDetail || ctx.timings.contentDetail || null,
          items: (ctx.rag.recipes || []).map((r) => ({
            name: r.name,
            slug: r.slug,
            score: r._score, // eslint-disable-line no-underscore-dangle
          })),
        },
        guides: {
          count: ctx.rag.guides?.length || 0,
          ms: ctx.timings.guidesMs || 0,
          detail: ctx.timings.contentDetail || null,
          items: (ctx.rag.guides || []).map((g) => ({
            title: g.title,
            slug: g.slug,
            score: g.score,
          })),
        },
        experiences: {
          count: ctx.rag.experiences?.length || 0,
          ms: ctx.timings.experiencesMs || 0,
          detail: ctx.timings.contentDetail || null,
          items: (ctx.rag.experiences || []).map((e) => ({
            title: e.title,
            slug: e.slug,
            score: e.score,
          })),
        },
        comparisons: {
          count: ctx.rag.comparisons?.length || 0,
          ms: ctx.timings.content || 0,
          items: (ctx.rag.comparisons || []).map((c) => ({
            title: c.title,
            slug: c.slug,
            source: c._source, // eslint-disable-line no-underscore-dangle
          })),
        },
        tools: {
          count: ctx.rag.toolContent?.length || 0,
          ms: ctx.timings.content || 0,
          items: (ctx.rag.toolContent || []).map((t) => ({
            title: t.title,
            slug: t.slug,
            score: t.score,
          })),
        },
        heroImages: {
          count: ctx.rag.heroImages?.length || 0,
          items: (ctx.rag.heroImages || []).map((h) => ({
            id: h.id,
            score: h.score,
            category: h.category,
          })),
        },
        products: {
          count: ctx.rag.products?.length || 0,
          ms: ctx.timings.products || 0,
          items: (ctx.rag.products || []).map((p) => ({
            name: p.name,
            id: p.id,
            score: p.score,
            price: p.price,
          })),
        },
        faqs: {
          count: ctx.rag.faqs?.length || 0,
          ms: ctx.timings.faqs || 0,
          items: (ctx.rag.faqs || []).map((f) => ({
            question: f.question.substring(0, 80),
          })),
        },
        reviews: {
          count: ctx.rag.reviews?.length || 0,
          ms: ctx.timings.reviews || 0,
          items: (ctx.rag.reviews || []).map((r) => ({
            author: r.author,
            product: r.productId,
          })),
        },
        persona: {
          name: ctx.rag.persona?.name || null,
          ms: ctx.timings.persona || 0,
        },
        useCase: {
          name: ctx.rag.useCase?.name || null,
          ms: ctx.timings.useCase || 0,
        },
        features: {
          count: ctx.rag.features?.length || 0,
          ms: ctx.timings.features || 0,
          items: (ctx.rag.features || []).map((f) => ({
            name: f.name,
            benefit: f.benefit,
          })),
        },
      },
      prompt: {
        systemLength: ctx.prompt.system.length,
        userLength: ctx.prompt.user.length,
        systemPrompt: ctx.prompt.system,
        userMessage: ctx.prompt.user,
        flags: {
          compact: !!ctx.request.compact,
          followUp: ctx.request.followUp
            ? { type: ctx.request.followUp.type, label: ctx.request.followUp.label }
            : null,
          interestSignals: !!ctx.request.interestSignals?.hoveredTopics?.length,
          previousTopics: ctx.request.previousTopics?.length || 0,
        },
      },
      llm: {
        provider: providerId,
        model,
        temperature,
        maxTokens,
        inputTokens: out.usage?.prompt_tokens || null,
        outputTokens: out.usage?.completion_tokens || null,
        totalTokens: out.usage?.total_tokens || null,
        cacheReadTokens: out.usage?.cache_read_tokens || null,
        cacheWriteTokens: out.usage?.cache_write_tokens || null,
        promptCacheHit: (out.usage?.cache_read_tokens || 0) > 0,
        chunks: tokenCount,
        outputLength: out.fullText.length,
        rawOutput: out.fullText,
        sections: out.sections.length,
        jsonSections: out.rawJsonSections,
      },
      parser: {
        outputSections: out.sections.length,
        sectionLengths: out.sections.map((s) => s.length),
        suggestionsCount: out.suggestions.length,
      },
      sectionDetails,
      flow: ctx.flowId || 'default',
      intent: ctx.intent,
      contentStrategy: ctx.contentStrategy,
      qualityScore: ctx.qualityScore,
    });
  }

  // Extract used product IDs from generated sections.
  const imageTokenRe = /\{\{product-image:([^}]+)\}\}/g;
  const usedProducts = [];
  const rawJson = JSON.stringify(out.rawJsonSections);
  let tokenMatch = imageTokenRe.exec(rawJson);
  while (tokenMatch) {
    const pid = tokenMatch[1].trim();
    if (!usedProducts.includes(pid)) usedProducts.push(pid);
    tokenMatch = imageTokenRe.exec(rawJson);
  }

  const title = extractTitle(out.sections[0] || '');

  if (emitDone) {
    await writeLine({ type: 'done', title, usedProducts });
  }

  return {
    title,
    usedProducts,
    tokenCount,
    sectionTimings,
    sectionDetails,
  };
}

export async function llmGenerate(ctx, config, env) {
  // Pick and pin the hero image for this run (module-global state in images.js).
  // Safe for single-request paths; the admin experiments fan-out calls this
  // ONCE before spawning variants so they all see the same hero.
  const heroImage = selectHeroImage({
    query: ctx.request?.query,
    useCases: ctx.rag?.useCase?.useCases,
    intentType: ctx.intent?.type,
    productIds: extractProductIds(ctx.request?.query || ''),
  }, ctx.rag?.heroImages || []);
  setHeroResult(heroImage);

  // Load test bypass: skip LLM and stream dummy content. RAG still ran upstream.
  if (ctx.request.headers?.get('x-skip-cerebras') === 'true') {
    await streamDummyContent(ctx);
    return;
  }

  const active = await getActiveLlmConfig(env);
  const resolved = resolveLlmConfig(active, config);

  await runLlmVariant(ctx, env, {
    variantId: null,
    provider: resolved.provider,
    model: resolved.model,
    temperature: resolved.temperature,
    maxTokens: resolved.maxTokens,
    out: ctx.llm,
    timings: ctx.timings,
    emitDebug: true,
    emitDone: true,
    llmTimeoutMs: config.llmTimeout,
  });

  writeEvent(
    env,
    'generation',
    'recommender',
    ctx.intent?.type || '',
    '',
    {
      durationMs: Date.now() - ctx.timings.start,
      inputTokens: ctx.llm.usage?.prompt_tokens || 0,
      outputTokens: ctx.llm.usage?.completion_tokens || 0,
    },
  );
}
