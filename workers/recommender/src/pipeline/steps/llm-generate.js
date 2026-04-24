/**
 * LLM Generate Step — streams AI content via Cerebras, parses sections incrementally.
 * Reads ctx.prompt.*. Writes ctx.llm.*, streams NDJSON to ctx.writer.
 * Token resolution and sanitization happen per-section inside this step.
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
 * Returns { html, debug } with per-step timings, token resolution details,
 * URL normalization changes, and sanitization status.
 */
export function processSectionDetailed(section) {
  const debug = {};

  // Step 0a: block-level content sanitization (e.g. drop empty testimonials).
  // Returning null here means the caller should skip the section entirely;
  // we emit '' so the existing hasContent() check does that for us.
  const cleaned = sanitizeBlockContent(section);
  if (!cleaned) {
    debug.skipped = 'empty-block-content';
    return { html: '', debug };
  }

  // Step 0b: Strip invented story/experience links on card blocks.
  // Any article-excerpt / blog-card / experience-cta row whose token slug or
  // manual href isn't in the bundled stories/experiences index is dropped.
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

  // Step 1: JSON → EDS HTML
  let t = Date.now();
  let html = sectionToHtml(cardClean);
  debug.jsonToHtmlMs = Date.now() - t;
  const hrefsAfterJson = extractHrefs(html);
  const tokensFound = extractContentTokens(html);

  // Step 2: Resolve content tokens ({{product:ID}}, {{recipe:NAME}}, etc.)
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

  // Step 3: Normalize product URLs
  t = Date.now();
  html = normalizeProductUrls(html);
  debug.normalizeUrlsMs = Date.now() - t;
  const hrefsAfterNorm = extractHrefs(html);

  // Compute which URLs were changed by normalization
  const urlChanges = [];
  for (let i = 0; i < Math.max(hrefsAfterTokens.length, hrefsAfterNorm.length); i += 1) {
    if (hrefsAfterTokens[i] !== hrefsAfterNorm[i]) {
      urlChanges.push({ from: hrefsAfterTokens[i] || null, to: hrefsAfterNorm[i] || null });
    }
  }
  debug.urlChanges = urlChanges;

  // All links at each stage for full visibility
  debug.links = {
    afterJsonToHtml: hrefsAfterJson,
    afterResolveTokens: hrefsAfterTokens,
    afterNormalizeUrls: hrefsAfterNorm,
  };

  // Step 4: Sanitize HTML (XSS protection)
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

/**
 * Check if section HTML has meaningful content (not just an empty wrapper div).
 */
function hasContent(html) {
  return html.replace(/<[^>]*>/g, '').trim().length > 0;
}

/**
 * Create a fallback hero section JSON when the LLM omits one as the first block.
 * Uses {{hero-image:main}} which resolves to the pre-selected hero image via images.js.
 */
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
// server-side post-parse (see llmGenerate) against a product the LLM picked.
const LLM_SUGGESTION_TYPES = ['explore', 'compare'];

/**
 * Extract the primary recommended product from generated JSON sections.
 * Checks columns blocks (product spotlights) first, then comparison-table recommended field.
 */
function extractPrimaryProduct(rawJsonSections) {
  const imageTokenRe = /\{\{product-image:([^}]+)\}\}/;

  // Strategy 1: columns block with product image → extract product ID from token
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

  // Strategy 2: comparison-table with data.recommended → match against row tokens
  const cmpBlock = rawJsonSections.find(
    (s) => s.block === 'comparison-table' && s.data?.recommended,
  );
  if (cmpBlock) {
    const recName = cmpBlock.data.recommended.toLowerCase().replace(/^vitamix\s+/i, '');
    const json = JSON.stringify(cmpBlock);
    const allIds = Array.from(json.matchAll(/\{\{product-image:([^}]+)\}\}/g))
      .map((m) => m[1].trim());

    // Try to match the recommended product name
    const matched = allIds.reduce((found, id) => {
      if (found) return found;
      const data = getProductData(id);
      return (data && data.name.toLowerCase().includes(recName)) ? data : null;
    }, null);
    if (matched) return { id: matched.id, name: matched.name, url: matched.url };

    // Fallback: first valid product from the table
    const fallback = allIds.reduce((found, id) => {
      if (found) return found;
      return getProductData(id);
    }, null);
    if (fallback) return { id: fallback.id, name: fallback.name, url: fallback.url };
  }

  return null;
}

/**
 * Filter LLM suggestions to the allowed types and strip content-pushing labels.
 * A server-injected 'buy' CTA is added later in llmGenerate, not here.
 */
export function processSuggestions(suggestions) {
  if (!Array.isArray(suggestions)) return [];
  return suggestions.filter(
    (s) => s && s.label && LLM_SUGGESTION_TYPES.includes(s.type)
      && !/^(try |view |read |check out |browse |shop )/i.test(s.label),
  );
}

/**
 * Generate a page title from the first section HTML.
 */
export function extractTitle(firstSection) {
  const h1Match = firstSection.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1Match) return unescapeHtml(h1Match[1]);
  const h2Match = firstSection.match(/<h2[^>]*>([^<]+)<\/h2>/i);
  if (h2Match) return unescapeHtml(h2Match[1]);
  return '';
}

// eslint-disable-next-line import/prefer-default-export
/**
 * Dummy LLM bypass — streams pre-canned content without calling Cerebras.
 * Activated by the X-Skip-Cerebras request header (load testing only).
 * All upstream pipeline steps (RAG, Vectorize, embedding) still run normally.
 */
async function streamDummyContent(ctx) {
  const query = ctx.request?.query || 'your query';
  const dummySections = [
    `<div class="section"><h1>Results for: ${query}</h1><p>This is dummy content returned by the load test bypass. Cerebras was not called.</p></div>`,
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

export async function llmGenerate(ctx, config, env) {
  // Select hero image using hybrid keyword + vector scoring
  // Use only explicitly mentioned product IDs for hero selection — not all RAG
  // products — to avoid boosting generic content-page images that happen to list
  // many products in their metadata.
  const heroImage = selectHeroImage({
    query: ctx.request?.query,
    useCases: ctx.rag?.useCase?.useCases,
    intentType: ctx.intent?.type,
    productIds: extractProductIds(ctx.request?.query || ''),
  }, ctx.rag?.heroImages || []);
  setHeroResult(heroImage);

  // Load test bypass: skip Cerebras and return dummy content
  // Activated by X-Skip-Cerebras header — all upstream RAG steps still run
  if (ctx.request.headers?.get('x-skip-cerebras') === 'true') {
    await streamDummyContent(ctx);
    return;
  }

  // Resolve active provider + model from KV, with per-flow config as fallback.
  const active = await getActiveLlmConfig(env);
  const resolved = resolveLlmConfig(active, config);

  // Preflight: make sure all env vars the chosen model needs are present.
  // Fall through with a clear error instead of letting the vendor call fail.
  const entry = findCatalogEntry(resolved.provider, resolved.model)
    || { provider: resolved.provider, model: resolved.model };
  const { available, missing } = catalogAvailability(entry, env);
  if (!available) {
    const err = new Error(`Missing configuration for ${resolved.provider}/${resolved.model}: ${missing.join(', ')}. Set the required secrets or pick a different model in Admin → Model Settings.`);
    err.status = 400;
    throw err;
  }

  const provider = getProvider(resolved.provider);
  ctx.llm.model = resolved.model;
  ctx.llm.provider = resolved.provider;
  ctx.llm.temperature = resolved.temperature;
  ctx.llm.maxTokens = resolved.maxTokens;

  // Heartbeat to keep the connection alive while waiting for LLM
  const heartbeatInterval = setInterval(async () => {
    try {
      await ctx.writer.write(ctx.encoder.encode(`${JSON.stringify({ type: 'heartbeat' })}\n`));
    } catch {
      clearInterval(heartbeatInterval);
    }
  }, 3000);

  const LLM_TIMEOUT_MS = config.llmTimeout || 60_000;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), LLM_TIMEOUT_MS);

  ctx.timings.llmStart = Date.now();
  let completion;
  try {
    completion = provider.stream({
      env,
      model: resolved.model,
      messages: [
        { role: 'system', content: ctx.prompt.system },
        { role: 'user', content: ctx.prompt.user },
      ],
      maxTokens: resolved.maxTokens,
      temperature: resolved.temperature,
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

  // Incremental streaming: parse JSON blocks as they complete
  const parser = new StreamParser();
  const sectionTimings = [];
  const sectionDetails = [];
  let sectionIndex = 0;
  let tokenCount = 0;
  // Follow-up turns already have a hero from the first generation — skip injecting one
  let heroEnsured = !!ctx.request.followUp;

  try {
    // eslint-disable-next-line no-restricted-syntax
    for await (const chunk of completion) {
      if (chunk.type === 'usage') {
        ctx.llm.usage = chunk.usage;
        continue; // eslint-disable-line no-continue
      }
      const content = chunk.type === 'delta' ? chunk.text : null;
      if (content) {
        if (!ctx.timings.llmFirstToken) ctx.timings.llmFirstToken = Date.now();
        ctx.timings.llmLastToken = Date.now();
        ctx.llm.fullText += content;
        tokenCount += 1;

        // Feed to incremental parser
        const completedSections = parser.feed(content);
        // eslint-disable-next-line no-restricted-syntax
        for (const section of completedSections) {
          const { html, debug: sDebug } = processSectionDetailed(section);

          // Skip empty blocks
          if (!hasContent(html)) continue; // eslint-disable-line no-continue

          // Guarantee the first block is always a hero
          if (!heroEnsured) {
            heroEnsured = true;
            if (section.block !== 'hero') {
              const heroHtml = processSection(createFallbackHeroSection(ctx.request?.query));
              if (hasContent(heroHtml)) {
                const heroLine = JSON.stringify(
                  { type: 'section', index: sectionIndex, html: heroHtml },
                );
                ctx.ndjsonLines.push(heroLine);
                // eslint-disable-next-line no-await-in-loop
                await ctx.writer.write(ctx.encoder.encode(`${heroLine}\n`));
                sectionIndex += 1;
              }
            }
          }

          ctx.llm.rawJsonSections.push(section);
          ctx.llm.sections.push(html);
          sectionTimings.push(sDebug.totalMs);
          sectionDetails.push({
            index: sectionIndex,
            block: section.block,
            variants: section.variants || [],
            ...sDebug,
          });

          // Stream this section to the client immediately
          const line = JSON.stringify({ type: 'section', index: sectionIndex, html });
          ctx.ndjsonLines.push(line);
          // eslint-disable-next-line no-await-in-loop
          await ctx.writer.write(ctx.encoder.encode(`${line}\n`));
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

  ctx.timings.llmEnd = Date.now();

  // Finalize: process remaining buffer (last section + suggestions)
  ctx.timings.parseStart = Date.now();
  const final = parser.finalize();

  if (final.section) {
    const { html, debug: sDebug } = processSectionDetailed(final.section);

    if (hasContent(html)) {
      // Guarantee the first block is always a hero (handles LLMs that buffer all output)
      if (!heroEnsured) {
        heroEnsured = true;
        if (final.section.block !== 'hero') {
          const heroHtml = processSection(createFallbackHeroSection(ctx.request?.query));
          if (hasContent(heroHtml)) {
            const heroLine = JSON.stringify(
              { type: 'section', index: sectionIndex, html: heroHtml },
            );
            ctx.ndjsonLines.push(heroLine);
            await ctx.writer.write(ctx.encoder.encode(`${heroLine}\n`));
            sectionIndex += 1;
          }
        }
      }

      ctx.llm.rawJsonSections.push(final.section);
      ctx.llm.sections.push(html);
      sectionTimings.push(sDebug.totalMs);
      sectionDetails.push({
        index: sectionIndex,
        block: final.section.block,
        variants: final.section.variants || [],
        ...sDebug,
      });

      const line = JSON.stringify({ type: 'section', index: sectionIndex, html });
      ctx.ndjsonLines.push(line);
      await ctx.writer.write(ctx.encoder.encode(`${line}\n`));
      sectionIndex += 1;
    }
  }

  if (final.suggestions) {
    ctx.llm.suggestions = processSuggestions(final.suggestions);

    // Inject buy CTA for the primary recommended product (server-authored, not LLM)
    const primary = extractPrimaryProduct(ctx.llm.rawJsonSections);
    if (primary) {
      ctx.llm.suggestions.unshift({
        type: 'buy',
        label: `Buy ${primary.name}`,
        query: primary.id,
        href: primary.url,
      });
    }
  }
  ctx.timings.parseEnd = Date.now();

  // Send suggestions
  if (ctx.llm.suggestions.length) {
    const sugLine = JSON.stringify({ type: 'suggestions', items: ctx.llm.suggestions });
    ctx.ndjsonLines.push(sugLine);
    await ctx.writer.write(ctx.encoder.encode(`${sugLine}\n`));
  }

  // Send debug timing data
  // Calculate context time from steps array (accounts for parallel execution)
  const contextTime = (ctx.timings.steps || [])
    .filter((s) => !s.gate)
    .reduce((sum, s) => sum + s.ms, 0);

  const debugLine = JSON.stringify({
    type: 'debug',
    timings: {
      total: Date.now() - ctx.timings.start,
      context: contextTime,
      prompt: ctx.timings.prompt || 0,
      llm: ctx.timings.llmEnd - ctx.timings.llmStart,
      llmFirstToken: ctx.timings.llmFirstToken
        ? ctx.timings.llmFirstToken - ctx.timings.llmStart : null,
      llmLastToken: ctx.timings.llmLastToken
        ? ctx.timings.llmLastToken - ctx.timings.llmStart : null,
      llmStreaming: (ctx.timings.llmFirstToken && ctx.timings.llmLastToken)
        ? ctx.timings.llmLastToken - ctx.timings.llmFirstToken : null,
      parse: ctx.timings.parseEnd - ctx.timings.parseStart,
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
      provider: resolved.provider,
      model: resolved.model,
      temperature: resolved.temperature,
      maxTokens: resolved.maxTokens,
      inputTokens: ctx.llm.usage?.prompt_tokens || null,
      outputTokens: ctx.llm.usage?.completion_tokens || null,
      totalTokens: ctx.llm.usage?.total_tokens || null,
      chunks: tokenCount,
      outputLength: ctx.llm.fullText.length,
      rawOutput: ctx.llm.fullText,
      sections: ctx.llm.sections.length,
      jsonSections: ctx.llm.rawJsonSections,
    },
    parser: {
      outputSections: ctx.llm.sections.length,
      sectionLengths: ctx.llm.sections.map((s) => s.length),
      suggestionsCount: ctx.llm.suggestions.length,
    },
    sectionDetails,
    flow: ctx.flowId || 'default',
    intent: ctx.intent,
    contentStrategy: ctx.contentStrategy,
    qualityScore: ctx.qualityScore,
  });
  ctx.ndjsonLines.push(debugLine);
  await ctx.writer.write(ctx.encoder.encode(`${debugLine}\n`));

  // Extract used product IDs from generated sections
  const imageTokenRe = /\{\{product-image:([^}]+)\}\}/g;
  const usedProducts = [];
  const rawJson = JSON.stringify(ctx.llm.rawJsonSections);
  let tokenMatch = imageTokenRe.exec(rawJson);
  while (tokenMatch) {
    const pid = tokenMatch[1].trim();
    if (!usedProducts.includes(pid)) usedProducts.push(pid);
    tokenMatch = imageTokenRe.exec(rawJson);
  }

  // Send done
  const title = extractTitle(ctx.llm.sections[0] || '');
  const doneLine = JSON.stringify({ type: 'done', title, usedProducts });
  ctx.ndjsonLines.push(doneLine);
  await ctx.writer.write(ctx.encoder.encode(`${doneLine}\n`));

  // Track generation event in Analytics Engine (fire-and-forget)
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
