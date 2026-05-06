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
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 800;

const RUBRIC = `Score on each dimension 1-5 (1=poor, 5=excellent) with one short sentence of reasoning:

1. structure: Are the EDS blocks well-formed? Are required sections present (hero, intro, recommendation cards)? No malformed HTML?
2. intent: Does the page actually answer the user's query? Does the focus match the expected intent?
3. faithfulness: Are products, prices, specs, and claims grounded in the RAG context provided? Penalize hallucinated SKUs, prices, links, or specs that aren't in the context.
4. helpfulness: Editorial quality - tone, hierarchy, prose flow, useful next steps. Would a real shopper find this trustworthy and useful?

Respond with JSON only, no preamble. Schema:
{"structure":{"score":N,"reasoning":"..."},"intent":{"score":N,"reasoning":"..."},"faithfulness":{"score":N,"reasoning":"..."},"helpfulness":{"score":N,"reasoning":"..."}}`;

function summarizeRagContext(ctx) {
  const products = (ctx?.rag?.products || []).slice(0, 12).map((p) => {
    const price = p.price != null ? ` $${p.price}` : '';
    return `${p.id || p.sku || ''} ${p.name || ''}${price}`.trim();
  });
  const features = (ctx?.rag?.features || []).slice(0, 10).map((f) => f.name).filter(Boolean);
  const recipes = (ctx?.rag?.recipes || []).slice(0, 8).map((r) => r.name).filter(Boolean);
  const faqs = (ctx?.rag?.faqs || []).slice(0, 6).map((f) => f.question || f.q).filter(Boolean);
  return {
    products: products.length ? products : ['(none)'],
    features: features.length ? features : ['(none)'],
    recipes: recipes.length ? recipes : ['(none)'],
    faqs: faqs.length ? faqs : ['(none)'],
  };
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

  return `You are evaluating an AI-generated coffee-discovery webpage produced by a recommender system. Score the page on four dimensions, each 1-5.

INPUT
User query: "${query}"
${intentLine}
Journey stage: ${journeyStage || '(none)'}

RAG CONTEXT (the only sources of truth available at generation time):
- Products: ${ctxSummary.products.join('; ')}
- Features: ${ctxSummary.features.join('; ')}
- Recipes: ${ctxSummary.recipes.join('; ')}
- FAQs: ${ctxSummary.faqs.join('; ')}

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

function compositeScore(dims) {
  const scores = ['structure', 'intent', 'faithfulness', 'helpfulness']
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
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, RETRY_BASE_MS * (attempt + 1)); });
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
  };
  const score = compositeScore(dims);
  const summary = `${dims.structure.score}·${dims.intent.score}·${dims.faithfulness.score}·${dims.helpfulness.score}`;

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
