/**
 * LLM provider registry — vendor-agnostic streaming contract used by llm-generate.
 *
 * Each provider exports a default object with:
 *   - id: 'cerebras' | 'cloudflare' | 'sambanova'
 *   - async *stream({ env, model, messages, temperature, maxTokens, signal })
 *       yields { type: 'delta', text } and a final { type: 'usage', usage }
 */

import cerebras from './cerebras.js';
import cloudflare from './cloudflare.js';
import sambanova from './sambanova.js';

const PROVIDERS = {
  cerebras,
  cloudflare,
  sambanova,
};

/**
 * Hardcoded catalog of selectable {provider, model} pairs.
 * Extend with new models by adding a single row here and redeploying.
 */
export const MODEL_CATALOG = [
  {
    provider: 'cerebras',
    model: 'gpt-oss-120b',
    label: 'Cerebras · GPT-OSS 120B (3000 tokens/s)',
  },
  {
    provider: 'cerebras',
    model: 'llama3.1-8b',
    label: 'Cerebras · Llama 3.3 70B (2200 tokens/s)',
  },
  {
    provider: 'cerebras',
    model: 'qwen-3-235b-a22b-instruct-2507',
    label: 'Cerebras · Qwen 3 235B Instruct (1400 tokens/s)',
  },
  {
    provider: 'cerebras',
    model: 'zai-glm-4.7',
    label: 'Cerebras · Z.ai GLM 4.7 (1000 tokens/s)',
  },
  {
    provider: 'cloudflare',
    model: '@cf/openai/gpt-oss-120b',
    label: 'Cloudflare · GPT-OSS 120B',
  },
  {
    provider: 'cloudflare',
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    label: 'Cloudflare · Llama 3.3 70B (fp8)',
  },
  {
    provider: 'cloudflare',
    model: '@cf/qwen/qwq-32b',
    label: 'Cloudflare · QwQ 32B',
  },
  {
    provider: 'cloudflare',
    model: '@cf/moonshotai/kimi-k2.6',
    label: 'Cloudflare · Moonshot Kimi K2.6',
  },
  {
    provider: 'cloudflare',
    model: '@cf/google/gemma-4-26b-a4b-it',
    label: 'Cloudflare · Gemma 4 26B A4B IT',
  },
  {
    provider: 'cloudflare',
    model: '@cf/google/gemma-3-12b-it',
    label: 'Cloudflare · Gemma 3 12B IT',
  },
  {
    provider: 'cloudflare',
    model: '@cf/zai-org/glm-4.7-flash',
    label: 'Cloudflare · Z.ai GLM 4.7 Flash',
  },
  {
    provider: 'cloudflare',
    model: '@cf/nvidia/nemotron-3-120b-a12b',
    label: 'Cloudflare · Nvidia Nemotron 3 120B A12B',
  },
  {
    provider: 'cloudflare',
    model: 'anthropic/claude-opus-4.7',
    label: 'Cloudflare · Anthropic Claude Opus 4.7',
    requires: ['AI_GATEWAY_ID', 'ANTHROPIC_API_KEY'],
  },
  {
    provider: 'cloudflare',
    model: 'anthropic/claude-sonnet-4.6',
    label: 'Cloudflare · Anthropic Claude Sonnet 4.6',
    requires: ['AI_GATEWAY_ID', 'ANTHROPIC_API_KEY'],
  },
  {
    provider: 'cloudflare',
    model: 'anthropic/claude-haiku-4.5',
    label: 'Cloudflare · Anthropic Claude Haiku 4.5',
    requires: ['AI_GATEWAY_ID', 'ANTHROPIC_API_KEY'],
  },
  {
    provider: 'cloudflare',
    model: 'google/gemini-3.1-flash-lite',
    label: 'Cloudflare · Google Gemini 3.1 Flash Lite',
    requires: ['AI_GATEWAY_ID', 'GOOGLE_AI_STUDIO_API_KEY'],
  },
  {
    provider: 'cloudflare',
    model: 'openai/gpt-5.4-nano',
    label: 'Cloudflare · OpenAI GPT-5.4 Nano',
    requires: ['AI_GATEWAY_ID', 'OPENAI_API_KEY'],
  },
  {
    provider: 'cloudflare',
    model: 'alibaba/qwen3.5-397b-a17b',
    label: 'Cloudflare · Alibaba Qwen 3.5 397B A17B',
    requires: ['AI_GATEWAY_ID', 'DASHSCOPE_API_KEY'],
  },
  {
    provider: 'sambanova',
    model: 'Meta-Llama-3.3-70B-Instruct',
    label: 'SambaNova · Llama 3.3 70B',
  },
  {
    provider: 'sambanova',
    model: 'Llama-4-Maverick-17B-128E-Instruct',
    label: 'SambaNova · Llama 4 Maverick 17B 128E Instruct',
  },
  {
    provider: 'sambanova',
    model: 'DeepSeek-V3.1',
    label: 'SambaNova · DeepSeek V3.1',
  },
  {
    provider: 'sambanova',
    model: 'DeepSeek-V3.2',
    label: 'SambaNova · DeepSeek V3.2',
  },
  {
    provider: 'sambanova',
    model: 'MiniMax-M2.5',
    label: 'SambaNova · MiniMax M2.5',
  },
  {
    provider: 'sambanova',
    model: 'gpt-oss-120b',
    label: 'SambaNova · GPT-OSS 120B',
  },
];

export const DEFAULT_CATALOG_ENTRY = MODEL_CATALOG[0];

export function findCatalogEntry(provider, model) {
  return (
    MODEL_CATALOG.find((e) => e.provider === provider && e.model === model)
    || null
  );
}

export function getProvider(name) {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`Unknown LLM provider: ${name}`);
  return p;
}

/**
 * Base env vars / bindings each provider needs to work at all.
 * Entry-level `requires` is layered on top (e.g. AI Gateway routing needs
 * AI_GATEWAY_ID + a vendor key).
 */
const PROVIDER_BASE_REQUIREMENTS = {
  cerebras: (env) => (env.CEREBRAS_API_KEY ? [] : ['CEREBRAS_API_KEY']),
  sambanova: (env) => (env.SAMBANOVA_API_KEY ? [] : ['SAMBANOVA_API_KEY']),
  cloudflare: (env) => (env.AI ? [] : ['AI (binding)']),
};

/**
 * Compute what a catalog entry needs from env vs. what is actually present.
 * Returns { available: boolean, missing: string[] }.
 */
export function catalogAvailability(entry, env = {}) {
  const base = PROVIDER_BASE_REQUIREMENTS[entry.provider]?.(env) || [];
  const extra = (entry.requires || []).filter((k) => !env[k]);
  const missing = [...base, ...extra];
  return { available: missing.length === 0, missing };
}
