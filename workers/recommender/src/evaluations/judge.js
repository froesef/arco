/**
 * LLM judge — scores a generated recommender page on four dimensions
 * (structure, intent, faithfulness, helpfulness) using the Anthropic
 * Messages API. Designed for batch evaluation, called once per variant.
 *
 * Uses ANTHROPIC_EVAL_API_KEY (separate from any production Anthropic key
 * so judging cost can be tracked independently).
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Catalog of allowed judge models. Hardcoded so the admin form can validate.
export const JUDGE_MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (recommended)', defaults: { inputPerMillion: 3, outputPerMillion: 15 } },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7 (1M context)', defaults: { inputPerMillion: 15, outputPerMillion: 75 } },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (cheapest)', defaults: { inputPerMillion: 1, outputPerMillion: 5 } },
];

const JUDGE_BY_ID = new Map(JUDGE_MODELS.map((m) => [m.id, m]));

export function isValidJudgeModel(id) {
  return JUDGE_BY_ID.has(id);
}

export function getJudgeRates(id) {
  return JUDGE_BY_ID.get(id)?.defaults || { inputPerMillion: 3, outputPerMillion: 15 };
}

// Anthropic accepts dated model ids; map our short ids to a stable concrete model.
const MODEL_ID_MAP = {
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-opus-4-7': 'claude-opus-4-7',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
};

const MAX_BLOCK_CHARS = 24_000; // ~6k tokens of generated HTML; truncates long pages.
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 800;

const RUBRIC = `Score on each dimension 1–5 (1=poor, 5=excellent) with one short sentence of reasoning:

1. structure: Are the EDS blocks well-formed? Are required sections present (hero, intro, recommendation cards)? No malformed HTML?
2. intent: Does the page actually answer the user's query? Does the focus match the expected intent?
3. faithfulness: Are products, prices, specs, and claims grounded in the RAG context provided? Penalize hallucinated SKUs, prices, links, or specs that aren't in the context.
4. helpfulness: Editorial quality — tone, hierarchy, prose flow, useful next steps. Would a real shopper find this trustworthy and useful?

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

  return `You are evaluating an AI-generated coffee-discovery webpage produced by a recommender system. Score the page on four dimensions, each 1–5.

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
  // Try direct parse first; fall back to extracting the first {...} block.
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

async function callAnthropic({
  apiKey, model, prompt, maxTokens, signal,
}) {
  const body = {
    model: MODEL_ID_MAP[model] || model,
    max_tokens: maxTokens,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  };

  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (res.status === 429 || res.status >= 500) {
        // eslint-disable-next-line no-await-in-loop
        const text = await res.text().catch(() => '');
        lastErr = new Error(`Anthropic ${res.status}: ${text.slice(0, 200)}`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setTimeout(resolve, RETRY_BASE_MS * (attempt + 1)); });
        continue; // eslint-disable-line no-continue
      }
      if (!res.ok) {
        // eslint-disable-next-line no-await-in-loop
        const text = await res.text().catch(() => '');
        const err = new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      // eslint-disable-next-line no-await-in-loop
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (err.status && err.status < 500 && err.status !== 429) throw err;
      lastErr = err;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, RETRY_BASE_MS * (attempt + 1)); });
    }
  }
  throw lastErr || new Error('Anthropic request failed');
}

/**
 * Judge a single variant's generation.
 *
 * @param {object} env Worker env (must contain ANTHROPIC_EVAL_API_KEY).
 * @param {object} args
 *   - judgeModel: string (id from JUDGE_MODELS)
 *   - query: string (the original user query)
 *   - expectedIntent: string|null (from suite)
 *   - classifiedIntent: string|null (what the recommender's intent step produced)
 *   - journeyStage: string|null
 *   - rag: object (ctx.rag — products/features/recipes/faqs arrays)
 *   - blocks: array of {index, blockType, html}
 *   - signal: AbortSignal
 * @returns {Promise<{dims, score, summary, judgeModel, inputTokens, outputTokens, durationMs}>}
 */
export async function judgeVariant(env, args) {
  if (!env.ANTHROPIC_EVAL_API_KEY) {
    throw new Error('ANTHROPIC_EVAL_API_KEY not configured');
  }
  if (!isValidJudgeModel(args.judgeModel)) {
    throw new Error(`Unknown judge model: ${args.judgeModel}`);
  }

  const prompt = buildJudgePrompt(args);
  const start = Date.now();

  const json = await callAnthropic({
    apiKey: env.ANTHROPIC_EVAL_API_KEY,
    model: args.judgeModel,
    prompt,
    maxTokens: 1024,
    signal: args.signal,
  });

  const durationMs = Date.now() - start;
  const text = (json.content || [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('');

  const parsed = safeParseJudgeResponse(text);
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
    inputTokens: json.usage?.input_tokens || 0,
    outputTokens: json.usage?.output_tokens || 0,
    durationMs,
    rawResponse: text,
  };
}
