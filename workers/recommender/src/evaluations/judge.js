/**
 * LLM judge — scores a generated recommender page on four dimensions
 * (structure, intent, faithfulness, helpfulness) using Anthropic Claude
 * via AWS Bedrock. Designed for batch evaluation, called once per variant.
 *
 * Reuses the existing Bedrock provider (Converse Stream API + bearer token)
 * and the already-configured AWS_BEARER_TOKEN_BEDROCK secret — no separate
 * Anthropic API key needed.
 */

import bedrock from '../providers/bedrock.js';

// Judge models mapped to Bedrock cross-region inference profile ids.
export const JUDGE_MODELS = [
  {
    id: 'claude-sonnet-4-6',
    bedrockModel: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
    label: 'Bedrock · Claude Sonnet 4 (recommended)',
    defaults: { inputPerMillion: 3, outputPerMillion: 15 },
  },
  {
    id: 'claude-sonnet-4-5',
    bedrockModel: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    label: 'Bedrock · Claude Sonnet 4.5',
    defaults: { inputPerMillion: 3, outputPerMillion: 15 },
  },
  {
    id: 'claude-opus-4-7',
    bedrockModel: 'us.anthropic.claude-opus-4-20250514-v1:0',
    label: 'Bedrock · Claude Opus 4 (a.k.a. 4.7)',
    defaults: { inputPerMillion: 15, outputPerMillion: 75 },
  },
  {
    id: 'claude-opus-4-5',
    bedrockModel: 'us.anthropic.claude-opus-4-5-20251101-v1:0',
    label: 'Bedrock · Claude Opus 4.5',
    defaults: { inputPerMillion: 15, outputPerMillion: 75 },
  },
  {
    id: 'claude-haiku-4-5',
    bedrockModel: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    label: 'Bedrock · Claude Haiku 4.5 (cheapest)',
    defaults: { inputPerMillion: 1, outputPerMillion: 5 },
  },
];

const JUDGE_BY_ID = new Map(JUDGE_MODELS.map((m) => [m.id, m]));

export function isValidJudgeModel(id) {
  return JUDGE_BY_ID.has(id);
}

export function getJudgeRates(id) {
  return JUDGE_BY_ID.get(id)?.defaults || { inputPerMillion: 3, outputPerMillion: 15 };
}

const MAX_BLOCK_CHARS = 24_000; // ~6k tokens of generated HTML; truncates long pages.
// ~1.5k tokens of RAG context — enough for prices+specs without crowding blocks.
const MAX_RAG_CHARS = 6_000;
const MAX_RETRIES = 5;
// Exponential backoff base (ms). Sleep on attempt N is RETRY_BASE_MS * 2^N + jitter.
// So 1s, 2s, 4s, 8s, 16s for attempts 0..4 — keeps Bedrock 429s recoverable
// without blocking forever.
const RETRY_BASE_MS = 1000;
const RETRY_JITTER_MS = 500;

const RUBRIC = `Score on each dimension 1-5 (1=poor, 5=excellent) with one short sentence of reasoning:

1. structure: Are the EDS blocks well-formed? Are required sections present (hero, intro, recommendation cards)? No malformed HTML?
2. intent: Does the page actually answer the user's query? Does the focus match the expected intent?
3. faithfulness: Are products, prices, specs, and claims grounded in the RAG context provided? Penalize hallucinated SKUs, prices, links, or specs that aren't in the context.
4. helpfulness: Editorial quality - tone, hierarchy, prose flow, useful next steps. Would a real shopper find this trustworthy and useful?
5. brandVoice: Does the prose sound like a knowledgeable, approachable specialty-coffee brand (Arco)? Penalize generic AI-sounding filler, clichés ("In today's fast-paced world…"), overly salesy hype, or stiff/academic tone.
6. specificity: Does it use concrete coffee details — grams, ratios, temperatures, grind sizes, named techniques, named beans/origins — instead of vague generalities like "use a good amount" or "the right grind"? Score on the density and accuracy of useful specifics for the query type.
7. visualAssetUsage: Are images and visual assets used well? Hero image present and on-topic; product image tokens / story / experience tokens (e.g. {{story:slug}}, {{experience:slug}}) placed where they aid the reader; no missing or obviously broken assets.

Respond with JSON only, no preamble. Schema:
{"structure":{"score":N,"reasoning":"..."},"intent":{"score":N,"reasoning":"..."},"faithfulness":{"score":N,"reasoning":"..."},"helpfulness":{"score":N,"reasoning":"..."},"brandVoice":{"score":N,"reasoning":"..."},"specificity":{"score":N,"reasoning":"..."},"visualAssetUsage":{"score":N,"reasoning":"..."}}`;

function topSpecLines(specs) {
  if (!specs || typeof specs !== 'object') return [];
  // Pick the human-meaningful ones the judge actually needs to verify against.
  const preferred = ['boilers', 'pumpType', 'groupHead', 'pidControl', 'heatUpTime', 'waterSource'];
  return preferred
    .filter((key) => specs[key] !== undefined && specs[key] !== null && specs[key] !== '')
    .slice(0, 4)
    .map((key) => `${key}=${specs[key]}`);
}

function summarizeRagContext(ctx) {
  const products = (ctx?.rag?.products || []).slice(0, 12).map((p) => {
    const id = p.id || p.sku || '';
    const name = p.name || '';
    const price = p.price != null ? `$${p.price}` : '';
    const url = p.url || '';
    const tagline = p.tagline ? ` — ${p.tagline}` : '';
    const specLines = topSpecLines(p.specs);
    const specSuffix = specLines.length ? ` [${specLines.join(', ')}]` : '';
    return `${id} · ${name} ${price}${tagline}${specSuffix} ${url ? `(${url})` : ''}`.trim();
  });
  const features = (ctx?.rag?.features || []).slice(0, 10).map((f) => {
    const name = f.name || f.title || '';
    const desc = f.description || f.summary || '';
    const trimmed = desc ? ` — ${String(desc).slice(0, 120)}` : '';
    return `${name}${trimmed}`.trim();
  }).filter(Boolean);
  const recipes = (ctx?.rag?.recipes || []).slice(0, 8).map((r) => {
    const name = r.name || '';
    const url = r.url || (r.id ? `/recipes/${r.id}` : '');
    return url ? `${name} (${url})` : name;
  }).filter(Boolean);
  const faqs = (ctx?.rag?.faqs || []).slice(0, 6).map((f) => f.question || f.q).filter(Boolean);
  const stories = (ctx?.rag?.stories || []).slice(0, 6).map((s) => {
    const slug = s.slug || s.id || '';
    return slug ? `{{story:${slug}}}` : '';
  }).filter(Boolean);
  const experiences = (ctx?.rag?.experiences || []).slice(0, 6).map((e) => {
    const slug = e.slug || e.id || '';
    return slug ? `{{experience:${slug}}}` : '';
  }).filter(Boolean);
  return {
    products: products.length ? products : ['(none)'],
    features: features.length ? features : ['(none)'],
    recipes: recipes.length ? recipes : ['(none)'],
    faqs: faqs.length ? faqs : ['(none)'],
    stories: stories.length ? stories : ['(none)'],
    experiences: experiences.length ? experiences : ['(none)'],
  };
}

function clipContextString(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[RAG context truncated at ${max} chars]`;
}

function clipBlocks(blocks) {
  const joined = (blocks || [])
    .map((b, i) => `<!-- block ${i}: ${b.blockType || 'unknown'} -->\n${b.html || ''}`)
    .join('\n\n');
  if (joined.length <= MAX_BLOCK_CHARS) return { text: joined, truncated: false };
  return {
    text: `${joined.slice(0, MAX_BLOCK_CHARS)}\n\n<!-- ...truncated ${joined.length - MAX_BLOCK_CHARS} chars... -->`,
    truncated: true,
  };
}

function buildJudgePrompt({
  query,
  expectedIntent,
  expectedBehavior,
  classifiedIntent,
  journeyStage,
  rag,
  blocks,
}) {
  const ctxSummary = summarizeRagContext({ rag });
  const { text: blocksText, truncated } = clipBlocks(blocks);
  const intentLine = expectedIntent
    ? `Expected intent: ${expectedIntent}\nClassified intent: ${classifiedIntent || '(none)'}`
    : `Classified intent: ${classifiedIntent || '(none)'}`;
  const behaviorLine = expectedBehavior === 'decline'
    ? '\nExpected behavior: DECLINE — query is off-topic for a specialty-coffee assistant. The page should explain that the assistant is focused on coffee and not surface unrelated product recommendations. A page that confidently force-fits the off-topic query MUST score low on intent and faithfulness.'
    : '';

  const ragBlock = clipContextString(
    [
      `- Products (id · name · price · tagline · key specs · url): ${ctxSummary.products.join(' || ')}`,
      `- Features: ${ctxSummary.features.join(' || ')}`,
      `- Recipes: ${ctxSummary.recipes.join('; ')}`,
      `- FAQs: ${ctxSummary.faqs.join(' || ')}`,
      `- Story tokens available: ${ctxSummary.stories.join(', ')}`,
      `- Experience tokens available: ${ctxSummary.experiences.join(', ')}`,
    ].join('\n'),
    MAX_RAG_CHARS,
  );

  return `You are evaluating an AI-generated coffee-discovery webpage produced by a recommender system. Score the page on seven dimensions, each 1-5.

INPUT
User query: "${query}"
${intentLine}${behaviorLine}
Journey stage: ${journeyStage || '(none)'}

RAG CONTEXT (the ONLY sources of truth available at generation time — any product, price, spec, story slug, or experience slug NOT in this list is hallucinated and must be penalized on faithfulness):
${ragBlock}

GENERATED PAGE BLOCKS${truncated ? ' (truncated)' : ''}:
${blocksText}

${RUBRIC}`;
}

function safeParseJudgeResponse(text) {
  if (!text) throw new Error('Empty judge response');
  try {
    return JSON.parse(text.trim());
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Judge response was not valid JSON');
    return JSON.parse(match[0]);
  }
}

function clampDim(dim) {
  if (!dim || typeof dim !== 'object') return { score: 0, reasoning: 'missing' };
  const score = typeof dim.score === 'number' ? Math.max(1, Math.min(5, Math.round(dim.score))) : 0;
  const reasoning = typeof dim.reasoning === 'string' ? dim.reasoning.slice(0, 400) : '';
  return { score, reasoning };
}

const DIMENSION_KEYS = [
  'structure',
  'intent',
  'faithfulness',
  'helpfulness',
  'brandVoice',
  'specificity',
  'visualAssetUsage',
];

function compositeScore(dims) {
  const scores = DIMENSION_KEYS
    .map((k) => dims[k]?.score)
    .filter((s) => typeof s === 'number' && s > 0);
  if (!scores.length) return 0;
  return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100;
}

async function callBedrockOnce({
  env, bedrockModel, prompt, maxTokens, signal,
}) {
  let fullText = '';
  let usage = null;
  // Run the existing streaming Bedrock provider and concatenate deltas.
  // The judge is short and not user-visible, so we don't need progressive
  // rendering — we just need a final string + token counts.
  const stream = bedrock.stream({
    env,
    model: bedrockModel,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    maxTokens,
    signal,
  });
  // eslint-disable-next-line no-restricted-syntax
  for await (const chunk of stream) {
    if (chunk.type === 'delta') fullText += chunk.text;
    else if (chunk.type === 'usage') usage = chunk.usage;
  }
  return { fullText, usage };
}

async function callWithRetry(args) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await callBedrockOnce(args);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      const status = err.status || 0;
      // Retry only on throttle / 5xx — bail immediately on auth + bad request.
      if (status && status !== 429 && status < 500) throw err;
      lastErr = err;
      const sleepMs = RETRY_BASE_MS * (2 ** attempt) + Math.random() * RETRY_JITTER_MS;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, sleepMs); });
    }
  }
  throw lastErr || new Error('Bedrock judge call failed');
}

/**
 * Judge a single variant's generation.
 *
 * @param {object} env Worker env (must contain AWS_BEARER_TOKEN_BEDROCK; AWS_REGION optional).
 * @param {object} args
 *   - judgeModel: string (id from JUDGE_MODELS)
 *   - query: string
 *   - expectedIntent: string|null
 *   - expectedBehavior: 'decline'|null — when set to 'decline', the judge is told
 *     the query is off-topic and must score force-fit pages low.
 *   - classifiedIntent: string|null
 *   - journeyStage: string|null
 *   - rag: object
 *   - blocks: array of {index, blockType, html}
 *   - signal: AbortSignal
 * @returns {Promise<{dims, score, summary, judgeModel, inputTokens, outputTokens, durationMs}>}
 */
export async function judgeVariant(env, args) {
  if (!env.AWS_BEARER_TOKEN_BEDROCK) {
    throw new Error('AWS_BEARER_TOKEN_BEDROCK not configured');
  }
  const judgeEntry = JUDGE_BY_ID.get(args.judgeModel);
  if (!judgeEntry) {
    throw new Error(`Unknown judge model: ${args.judgeModel}`);
  }

  const prompt = buildJudgePrompt(args);
  const start = Date.now();

  const { fullText, usage } = await callWithRetry({
    env,
    bedrockModel: judgeEntry.bedrockModel,
    prompt,
    maxTokens: 1024,
    signal: args.signal,
  });

  const durationMs = Date.now() - start;
  const parsed = safeParseJudgeResponse(fullText);
  const dims = {
    structure: clampDim(parsed.structure),
    intent: clampDim(parsed.intent),
    faithfulness: clampDim(parsed.faithfulness),
    helpfulness: clampDim(parsed.helpfulness),
    brandVoice: clampDim(parsed.brandVoice),
    specificity: clampDim(parsed.specificity),
    visualAssetUsage: clampDim(parsed.visualAssetUsage),
  };
  const score = compositeScore(dims);
  const summary = DIMENSION_KEYS.map((k) => dims[k].score || '—').join('·');

  return {
    dims,
    score,
    summary,
    judgeModel: args.judgeModel,
    inputTokens: usage?.prompt_tokens || 0,
    outputTokens: usage?.completion_tokens || 0,
    durationMs,
    rawResponse: fullText,
  };
}
