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
  { provider: 'cerebras', model: 'gpt-oss-120b', label: 'Cerebras · GPT-OSS 120B' },
  { provider: 'cerebras', model: 'llama-3.3-70b', label: 'Cerebras · Llama 3.3 70B' },
  { provider: 'cerebras', model: 'qwen-3-235b-a22b-instruct-2507', label: 'Cerebras · Qwen 3 235B Instruct' },
  { provider: 'cloudflare', model: '@cf/openai/gpt-oss-120b', label: 'Cloudflare · GPT-OSS 120B' },
  { provider: 'cloudflare', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Cloudflare · Llama 3.3 70B (fp8)' },
  { provider: 'cloudflare', model: '@cf/qwen/qwq-32b', label: 'Cloudflare · QwQ 32B' },
  { provider: 'sambanova', model: 'Meta-Llama-3.3-70B-Instruct', label: 'SambaNova · Llama 3.3 70B' },
  { provider: 'sambanova', model: 'DeepSeek-V3.1', label: 'SambaNova · DeepSeek V3.1' },
  { provider: 'sambanova', model: 'DeepSeek-R1', label: 'SambaNova · DeepSeek R1' },
];

export const DEFAULT_CATALOG_ENTRY = MODEL_CATALOG[0];

export function findCatalogEntry(provider, model) {
  return MODEL_CATALOG.find((e) => e.provider === provider && e.model === model) || null;
}

export function getProvider(name) {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`Unknown LLM provider: ${name}`);
  return p;
}
