/**
 * LLM provider registry — vendor-agnostic streaming contract used by llm-generate.
 *
 * Each provider exports a default object with:
 *   - id: 'cerebras' | 'cloudflare' | 'sambanova'
 *   - async *stream({ env, model, messages, temperature, maxTokens, signal })
 *       yields { type: 'delta', text } and a final { type: 'usage', usage }
 */

import bedrock from './bedrock.js';
import cerebras from './cerebras.js';
import cloudflare from './cloudflare.js';
import sambanova from './sambanova.js';
import ollama from './ollama.js';
import vllm from './vllm.js';

const PROVIDERS = {
  bedrock,
  cerebras,
  cloudflare,
  sambanova,
  ollama,
  vllm,
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
  // Anthropic on Bedrock — Claude 4.x uses cross-region inference profiles (us.* prefix)
  {
    provider: 'bedrock', model: 'us.anthropic.claude-opus-4-20250514-v1:0', label: 'Bedrock · Claude Opus 4 (4.7)', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'us.anthropic.claude-opus-4-5-20251101-v1:0', label: 'Bedrock · Claude Opus 4.5', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'us.anthropic.claude-opus-4-1-20250805-v1:0', label: 'Bedrock · Claude Opus 4.1', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'us.anthropic.claude-sonnet-4-20250514-v1:0', label: 'Bedrock · Claude Sonnet 4 (4.6)', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', label: 'Bedrock · Claude Sonnet 4.5', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', label: 'Bedrock · Claude Haiku 4.5', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  // Amazon Nova on Bedrock
  {
    provider: 'bedrock', model: 'amazon.nova-2-lite-v1:0', label: 'Bedrock · Amazon Nova 2 Lite', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'amazon.nova-pro-v1:0', label: 'Bedrock · Amazon Nova Pro', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'amazon.nova-lite-v1:0', label: 'Bedrock · Amazon Nova Lite', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'amazon.nova-micro-v1:0', label: 'Bedrock · Amazon Nova Micro', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  // Meta on Bedrock (confirmed cross-region inference profiles)
  {
    provider: 'bedrock', model: 'us.meta.llama4-maverick-17b-instruct-v1:0', label: 'Bedrock · Llama 4 Maverick 17B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'us.meta.llama4-scout-17b-instruct-v1:0', label: 'Bedrock · Llama 4 Scout 17B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'us.meta.llama3-3-70b-instruct-v1:0', label: 'Bedrock · Llama 3.3 70B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'us.meta.llama3-2-90b-instruct-v1:0', label: 'Bedrock · Llama 3.2 90B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'us.meta.llama3-2-11b-instruct-v1:0', label: 'Bedrock · Llama 3.2 11B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'us.meta.llama3-2-3b-instruct-v1:0', label: 'Bedrock · Llama 3.2 3B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'us.meta.llama3-2-1b-instruct-v1:0', label: 'Bedrock · Llama 3.2 1B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'us.meta.llama3-1-70b-instruct-v1:0', label: 'Bedrock · Llama 3.1 70B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'us.meta.llama3-1-8b-instruct-v1:0', label: 'Bedrock · Llama 3.1 8B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  // DeepSeek on Bedrock
  {
    provider: 'bedrock', model: 'us.deepseek.r1-v1:0', label: 'Bedrock · DeepSeek-R1', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'deepseek.v3.2', label: 'Bedrock · DeepSeek V3.2', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  // Mistral on Bedrock
  {
    provider: 'bedrock', model: 'mistral.mistral-large-3-675b-instruct', label: 'Bedrock · Mistral Large 3', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'mistral.devstral-2-123b', label: 'Bedrock · Devstral 2 123B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'mistral.magistral-small-2509', label: 'Bedrock · Magistral Small', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'us.mistral.pixtral-large-2502-v1:0', label: 'Bedrock · Pixtral Large', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'mistral.ministral-3-14b-instruct', label: 'Bedrock · Ministral 14B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'mistral.ministral-3-8b-instruct', label: 'Bedrock · Ministral 8B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'mistral.ministral-3-3b-instruct', label: 'Bedrock · Ministral 3B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  // NVIDIA on Bedrock
  {
    provider: 'bedrock', model: 'nvidia.nemotron-super-3-120b', label: 'Bedrock · Nemotron Super 120B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'nvidia.nemotron-nano-3-30b', label: 'Bedrock · Nemotron Nano 30B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'nvidia.nemotron-nano-12b-v2', label: 'Bedrock · Nemotron Nano 12B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'nvidia.nemotron-nano-9b-v2', label: 'Bedrock · Nemotron Nano 9B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  // Qwen on Bedrock
  {
    provider: 'bedrock', model: 'qwen.qwen3-next-80b-a3b', label: 'Bedrock · Qwen3 Next 80B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'qwen.qwen3-coder-next', label: 'Bedrock · Qwen3 Coder Next', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'qwen.qwen3-32b-v1:0', label: 'Bedrock · Qwen3 32B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'qwen.qwen3-vl-235b-a22b', label: 'Bedrock · Qwen3 VL 235B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'qwen.qwen3-coder-30b-a3b-v1:0', label: 'Bedrock · Qwen3-Coder 30B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  // Google on Bedrock
  {
    provider: 'bedrock', model: 'google.gemma-3-27b-it', label: 'Bedrock · Gemma 3 27B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'google.gemma-3-12b-it', label: 'Bedrock · Gemma 3 12B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'google.gemma-3-4b-it', label: 'Bedrock · Gemma 3 4B', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  // Moonshot AI on Bedrock
  {
    provider: 'bedrock', model: 'moonshotai.kimi-k2.5', label: 'Bedrock · Kimi K2.5', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'moonshot.kimi-k2-thinking', label: 'Bedrock · Kimi K2 Thinking', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  // MiniMax on Bedrock
  {
    provider: 'bedrock', model: 'minimax.minimax-m2.5', label: 'Bedrock · MiniMax M2.5', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'minimax.minimax-m2.1', label: 'Bedrock · MiniMax M2.1', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'minimax.minimax-m2', label: 'Bedrock · MiniMax M2', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  // Z.AI on Bedrock
  {
    provider: 'bedrock', model: 'zai.glm-5', label: 'Bedrock · GLM 5', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'zai.glm-4.7', label: 'Bedrock · GLM 4.7', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'zai.glm-4.7-flash', label: 'Bedrock · GLM 4.7 Flash', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  // AI21 on Bedrock
  {
    provider: 'bedrock', model: 'ai21.jamba-1-5-large-v1:0', label: 'Bedrock · Jamba 1.5 Large', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    provider: 'bedrock', model: 'ai21.jamba-1-5-mini-v1:0', label: 'Bedrock · Jamba 1.5 Mini', requires: ['AWS_BEARER_TOKEN_BEDROCK'],
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
  // Ollama (local dev only — points at OLLAMA_BASE_URL, typically an
  // SSH-forwarded EC2 instance). These are representative entries for the admin
  // dropdown; any pulled model works via env (OLLAMA_MODEL) thanks to the
  // synthesize path in findCatalogEntry below.
  {
    provider: 'ollama',
    model: 'llama3.1:8b',
    label: 'Ollama · Llama 3.1 8B (local)',
  },
  {
    provider: 'ollama',
    model: 'qwen2.5:7b',
    label: 'Ollama · Qwen 2.5 7B (local)',
  },
  // vLLM (OpenAI-compatible server at VLLM_BASE_URL — local or SSH-forwarded).
  // Representative entry for the dropdown; any served model works via the
  // synthesize path in findCatalogEntry below.
  {
    provider: 'vllm',
    model: 'served-model',
    label: 'vLLM · served model (set VLLM_BASE_URL)',
  },
];

export const DEFAULT_CATALOG_ENTRY = MODEL_CATALOG[0];

export function findCatalogEntry(provider, model) {
  const found = MODEL_CATALOG.find((e) => e.provider === provider && e.model === model);
  if (found) return found;
  // Ollama and vLLM run arbitrary served models; synthesize an entry for any
  // model string so env-driven selection and admin Model Settings both validate
  // without a catalog edit per model.
  if ((provider === 'ollama' || provider === 'vllm') && model) {
    const label = provider === 'ollama' ? `Ollama · ${model}` : `vLLM · ${model}`;
    return { provider, model, label };
  }
  return null;
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
  bedrock: (env) => (env.AWS_BEARER_TOKEN_BEDROCK ? [] : ['AWS_BEARER_TOKEN_BEDROCK']),
  cerebras: (env) => (env.CEREBRAS_API_KEY ? [] : ['CEREBRAS_API_KEY']),
  sambanova: (env) => (env.SAMBANOVA_API_KEY ? [] : ['SAMBANOVA_API_KEY']),
  cloudflare: (env) => (env.AI ? [] : ['AI (binding)']),
  ollama: (env) => (env.OLLAMA_BASE_URL ? [] : ['OLLAMA_BASE_URL']),
  vllm: (env) => (env.VLLM_BASE_URL ? [] : ['VLLM_BASE_URL']),
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

/**
 * Query a live local provider for the models it is actually serving, so the
 * admin picker can show real ids instead of the `served-model` / `llama3.1:8b`
 * placeholders. Returns null on any failure (server down, timeout, not
 * configured) — callers fall back to the static catalog entries.
 *
 * Only ollama/vllm are dynamic; cloud providers stay hardcoded. In production
 * the *_BASE_URL vars are unset, so these short-circuit with no network call.
 */
async function fetchJson(url, { headers, timeoutMs = 2500 } = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchVllmModels(env) {
  if (!env.VLLM_BASE_URL) return null;
  const base = env.VLLM_BASE_URL.replace(/\/+$/, '');
  const url = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
  const headers = env.VLLM_API_KEY ? { Authorization: `Bearer ${env.VLLM_API_KEY}` } : undefined;
  const data = await fetchJson(url, { headers });
  if (!data) return null;
  return (data.data || []).map((m) => m.id).filter(Boolean);
}

async function fetchOllamaModels(env) {
  if (!env.OLLAMA_BASE_URL) return null;
  const base = env.OLLAMA_BASE_URL.replace(/\/+$/, '').replace(/\/v1$/, '');
  const data = await fetchJson(`${base}/api/tags`);
  if (!data) return null;
  return (data.models || []).map((m) => m.name).filter(Boolean);
}

/**
 * Build the selectable catalog for the admin picker. Starts from MODEL_CATALOG,
 * then for any local provider that is configured AND reachable, replaces its
 * placeholder rows with one entry per actually-served model. Falls back to the
 * static placeholder when the server can't be reached.
 */
export async function getCatalog(env = {}) {
  const [vllmModels, ollamaModels] = await Promise.all([
    fetchVllmModels(env),
    fetchOllamaModels(env),
  ]);

  // Drop placeholder rows for providers we have live data for.
  const entries = MODEL_CATALOG.filter((e) => {
    if (e.provider === 'vllm' && vllmModels) return false;
    if (e.provider === 'ollama' && ollamaModels) return false;
    return true;
  });

  (vllmModels || []).forEach((id) => {
    entries.push({ provider: 'vllm', model: id, label: `vLLM · ${id}` });
  });
  (ollamaModels || []).forEach((name) => {
    entries.push({ provider: 'ollama', model: name, label: `Ollama · ${name}` });
  });

  return entries;
}
