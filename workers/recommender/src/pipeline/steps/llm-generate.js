/**
 * LLM Generate Step — streams AI content via Cerebras, parses sections incrementally.
 * Reads ctx.prompt.*. Writes ctx.llm.*, streams NDJSON to ctx.writer.
 * Token resolution and sanitization happen per-section inside this step.
 */

// eslint-disable-next-line import/no-unresolved
import Cerebras from '@cerebras/cerebras_cloud_sdk';
import { sectionToHtml } from '../../json-to-eds.js';
import {
  resolveTokens, normalizeProductUrls, getProductData, setHeroContext,
} from '../../images.js';
import sanitizeHTML from '../../sanitize.js';
import { StreamParser } from '../../stream-parser.js';
import { unescapeHtml } from '../../da-persist.js';

/**
 * Process a completed JSON section: convert to HTML, resolve tokens, sanitize.
 */
export function processSection(section) {
  let html = sectionToHtml(section);
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

  // Step 1: JSON → EDS HTML
  let t = Date.now();
  let html = sectionToHtml(section);
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

const VALID_SUGGESTION_TYPES = ['explore', 'compare', 'recipe', 'buy', 'quiz', 'customize'];

/**
 * Extract the primary recommended product from generated JSON sections.
 * Checks product-recommendation blocks first, then comparison-table recommended field.
 */
function extractPrimaryProduct(rawJsonSections) {
  const imageTokenRe = /\{\{product-image:([^}]+)\}\}/;

  // Strategy 1: product-recommendation block → extract product ID from token
  const recBlock = rawJsonSections.find((s) => s.block === 'product-recommendation');
  if (recBlock) {
    const match = JSON.stringify(recBlock).match(imageTokenRe);
    if (match) {
      const data = getProductData(match[1].trim());
      if (data) return { id: data.id, name: data.name };
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
    if (matched) return { id: matched.id, name: matched.name };

    // Fallback: first valid product from the table
    const fallback = allIds.reduce((found, id) => {
      if (found) return found;
      return getProductData(id);
    }, null);
    if (fallback) return { id: fallback.id, name: fallback.name };
  }

  return null;
}

/**
 * Enrich buy suggestions with product data.
 */
export function processSuggestions(suggestions) {
  if (!Array.isArray(suggestions)) return [];

  return suggestions
    .filter((s) => s && s.label && VALID_SUGGESTION_TYPES.includes(s.type))
    .map((s) => {
      if (s.type === 'buy') {
        const productData = getProductData(s.query);
        if (!productData) return null;
        return { ...s, productData };
      }
      return s;
    })
    .filter(Boolean);
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
export async function llmGenerate(ctx, config, env) {
  // Set hero image context so {{hero-image:main}} resolves to a contextual image
  setHeroContext({
    query: ctx.request?.query,
    useCases: ctx.rag?.useCase?.useCases,
    intentType: ctx.rag?.intentClassification?.intentType,
    productIds: (ctx.rag?.products || []).map((p) => p.id),
  });

  const client = new Cerebras({ apiKey: env.CEREBRAS_API_KEY });

  // Heartbeat to keep the connection alive while waiting for LLM
  const heartbeatInterval = setInterval(async () => {
    try {
      await ctx.writer.write(ctx.encoder.encode(`${JSON.stringify({ type: 'heartbeat' })}\n`));
    } catch {
      clearInterval(heartbeatInterval);
    }
  }, 3000);

  ctx.timings.llmStart = Date.now();
  let completion;
  try {
    completion = await client.chat.completions.create({
      model: config.model || 'gpt-oss-120b',
      messages: [
        { role: 'system', content: ctx.prompt.system },
        { role: 'user', content: ctx.prompt.user },
      ],
      max_tokens: config.maxTokens || 4096,
      temperature: config.temperature ?? 0.7,
      stream: true,
    });
  } catch (llmErr) {
    clearInterval(heartbeatInterval);
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

  // eslint-disable-next-line no-restricted-syntax
  for await (const chunk of completion) {
    const content = chunk.choices?.[0]?.delta?.content;
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
    if (chunk.usage) ctx.llm.usage = chunk.usage;
    if (chunk.x_cerebras?.usage) ctx.llm.usage = chunk.x_cerebras.usage;
  }

  clearInterval(heartbeatInterval);
  ctx.timings.llmEnd = Date.now();

  // Finalize: process remaining buffer (last section + suggestions)
  ctx.timings.parseStart = Date.now();
  const final = parser.finalize();

  if (final.section) {
    const { html, debug: sDebug } = processSectionDetailed(final.section);

    if (hasContent(html)) {
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
    // Recommender flow: only explore/compare from LLM, strip content-pushing labels
    if (ctx.flowId === 'recommender') {
      ctx.llm.suggestions = ctx.llm.suggestions
        .filter((s) => s.type === 'explore' || s.type === 'compare')
        .filter((s) => !/^(try |view |read |check out |browse |shop )/i.test(s.label));

      // Inject buy CTA for the primary recommended product
      const primary = extractPrimaryProduct(ctx.llm.rawJsonSections);
      if (primary) {
        ctx.llm.suggestions.unshift({
          type: 'buy',
          label: `Buy ${primary.name}`,
          query: primary.id,
          href: `/us/en_us/products/${primary.id}`,
        });
      }
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
      articles: {
        count: ctx.rag.articles?.length || 0,
        ms: ctx.timings.articles || 0,
        detail: ctx.timings.articlesDetail || ctx.timings.contentDetail || null,
        // eslint-disable-next-line no-underscore-dangle
        items: (ctx.rag.articles || []).map((a) => ({
          title: a.title,
          score: a._score, // eslint-disable-line no-underscore-dangle
          section: a._matchedSection, // eslint-disable-line no-underscore-dangle
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
      model: config.model || 'gpt-oss-120b',
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
}
