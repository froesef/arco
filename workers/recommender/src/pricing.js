/**
 * LLM cost model — converts the token counts already stored on
 * `generated_pages` into real dollars.
 *
 * Prices are USD per 1M tokens, list price, as published by each vendor.
 * They are approximations for a demo ROI model, not billing-grade figures:
 * negotiated rates, batch discounts and free tiers all change the real number.
 * Anything not in the table falls back to DEFAULT_PRICE so the dashboard
 * degrades to "roughly right" rather than silently reporting $0.
 */

// key: `${provider}:${model}` → { in, out } USD per 1M tokens
export const PROVIDER_PRICING = {
  // ─── Cerebras ──────────────────────────────────────────────────────────────
  'cerebras:gpt-oss-120b': { in: 0.25, out: 0.69 },
  'cerebras:qwen-3-235b-a22b-instruct-2507': { in: 0.60, out: 1.20 },
  'cerebras:zai-glm-4.7': { in: 0.50, out: 1.00 },
  'cerebras:gemma-4-31b': { in: 0.10, out: 0.10 },
  'cerebras:llama3.1-8b': { in: 0.10, out: 0.10 },

  // ─── Cloudflare Workers AI (open models) ───────────────────────────────────
  'cloudflare:@cf/openai/gpt-oss-120b': { in: 0.35, out: 0.75 },
  'cloudflare:@cf/meta/llama-3.3-70b-instruct-fp8-fast': { in: 0.29, out: 2.25 },
  'cloudflare:@cf/qwen/qwq-32b': { in: 0.66, out: 1.00 },
  'cloudflare:@cf/moonshotai/kimi-k2.6': { in: 0.60, out: 2.50 },
  'cloudflare:@cf/google/gemma-4-26b-a4b-it': { in: 0.20, out: 0.40 },
  'cloudflare:@cf/google/gemma-3-12b-it': { in: 0.35, out: 0.56 },
  'cloudflare:@cf/zai-org/glm-4.7-flash': { in: 0.20, out: 0.60 },
  'cloudflare:@cf/nvidia/nemotron-3-120b-a12b': { in: 0.35, out: 0.75 },

  // ─── Cloudflare AI Gateway → frontier models ───────────────────────────────
  'cloudflare:anthropic/claude-opus-4.7': { in: 15.00, out: 75.00 },
  'cloudflare:anthropic/claude-sonnet-4.6': { in: 3.00, out: 15.00 },
  'cloudflare:anthropic/claude-haiku-4.5': { in: 1.00, out: 5.00 },
  'cloudflare:google/gemini-3.1-flash-lite': { in: 0.10, out: 0.40 },
  'cloudflare:openai/gpt-5.4-nano': { in: 0.05, out: 0.40 },
  'cloudflare:alibaba/qwen3.5-397b-a17b': { in: 0.35, out: 1.40 },

  // ─── SambaNova ─────────────────────────────────────────────────────────────
  'sambanova:DeepSeek-V3.2': { in: 0.60, out: 1.70 },
  'sambanova:gpt-oss-120b': { in: 0.22, out: 0.59 },
  'sambanova:Meta-Llama-3.3-70B-Instruct': { in: 0.60, out: 1.20 },

  // ─── AWS Bedrock (also the eval judge) ─────────────────────────────────────
  'bedrock:anthropic.claude-sonnet-4-20250514-v1:0': { in: 3.00, out: 15.00 },
  'bedrock:anthropic.claude-opus-4-20250514-v1:0': { in: 15.00, out: 75.00 },
  'bedrock:anthropic.claude-3-5-haiku-20241022-v1:0': { in: 0.80, out: 4.00 },
};

// Self-hosted providers cost GPU time, not per-token fees. Treated as free
// here so a local-dev run doesn't pollute the ROI numbers with fake spend.
const FREE_PROVIDERS = new Set(['ollama', 'vllm']);

// Mid-range open-model pricing — used when a model isn't in the table.
export const DEFAULT_PRICE = { in: 0.30, out: 0.80 };

/**
 * Look up the price row for a provider/model pair.
 * @param {string} provider
 * @param {string} model
 * @returns {{in: number, out: number, known: boolean, free: boolean}}
 */
export function priceFor(provider, model) {
  if (FREE_PROVIDERS.has(provider)) {
    return {
      in: 0, out: 0, known: true, free: true,
    };
  }
  const row = PROVIDER_PRICING[`${provider}:${model}`];
  if (row) return { ...row, known: true, free: false };
  return { ...DEFAULT_PRICE, known: false, free: false };
}

/**
 * Cost of a single generation in USD.
 * @param {string} provider
 * @param {string} model
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number} USD
 */
export function costUsd(provider, model, inputTokens, outputTokens) {
  const p = priceFor(provider, model);
  const inTok = Number(inputTokens) || 0;
  const outTok = Number(outputTokens) || 0;
  return ((inTok * p.in) + (outTok * p.out)) / 1_000_000;
}

/**
 * SQL CASE expression mapping (llm_provider, llm_model) to a per-1M price so
 * cost can be aggregated inside D1 instead of pulling every row into the
 * worker. Returns dollars.
 *
 * @param {string} [inCol]  column holding input tokens
 * @param {string} [outCol] column holding output tokens
 * @returns {string} SQL expression
 */
export function costSqlExpression(inCol = 'input_tokens', outCol = 'output_tokens') {
  const inCases = [];
  const outCases = [];
  Object.entries(PROVIDER_PRICING).forEach(([key, price]) => {
    const [provider, ...rest] = key.split(':');
    const model = rest.join(':');
    const match = `WHEN llm_provider = '${provider}' AND llm_model = '${model}'`;
    inCases.push(`${match} THEN ${price.in}`);
    outCases.push(`${match} THEN ${price.out}`);
  });

  const freeCases = [...FREE_PROVIDERS]
    .map((p) => `WHEN llm_provider = '${p}' THEN 0`);

  const inExpr = `CASE ${freeCases.join(' ')} ${inCases.join(' ')} ELSE ${DEFAULT_PRICE.in} END`;
  const outExpr = `CASE ${freeCases.join(' ')} ${outCases.join(' ')} ELSE ${DEFAULT_PRICE.out} END`;

  return `((COALESCE(${inCol},0) * (${inExpr})) + (COALESCE(${outCol},0) * (${outExpr}))) / 1000000.0`;
}
