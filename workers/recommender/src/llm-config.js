/**
 * Runtime LLM configuration — active provider/model + generation params.
 * Stored in CACHE KV under `llm-config:active`. Falls back to flow defaults
 * and, ultimately, the first catalog entry.
 */

import { findCatalogEntry, DEFAULT_CATALOG_ENTRY } from './providers/index.js';

const KV_KEY = 'llm-config:active';

const TEMP_MIN = 0;
const TEMP_MAX = 2;
const TOKENS_MIN = 256;
const TOKENS_MAX = 16384;

function clamp(n, min, max) {
  if (typeof n !== 'number' || Number.isNaN(n)) return null;
  return Math.max(min, Math.min(max, n));
}

/**
 * Read the active LLM config from KV. Returns null on miss or if the stored
 * entry is no longer in the catalog.
 */
export async function getActiveLlmConfig(env) {
  if (!env.CACHE) return null;
  let stored;
  try {
    stored = await env.CACHE.get(KV_KEY, 'json');
  } catch {
    return null;
  }
  if (!stored || !stored.provider || !stored.model) return null;
  if (!findCatalogEntry(stored.provider, stored.model)) {
    console.warn(`[llm-config] stored entry not in catalog: ${stored.provider}/${stored.model}`);
    return null;
  }
  return {
    provider: stored.provider,
    model: stored.model,
    temperature: typeof stored.temperature === 'number' ? stored.temperature : null,
    maxTokens: typeof stored.maxTokens === 'number' ? stored.maxTokens : null,
    updatedAt: stored.updatedAt || null,
  };
}

/**
 * Validate + persist an LLM config patch. Returns the stored value on success
 * or { error } on validation failure.
 */
export async function putActiveLlmConfig(env, patch) {
  if (!env.CACHE) return { error: 'CACHE KV binding is not configured.' };
  if (!patch || typeof patch !== 'object') return { error: 'Invalid body.' };
  const entry = findCatalogEntry(patch.provider, patch.model);
  if (!entry) return { error: `Unknown provider/model: ${patch.provider}/${patch.model}` };

  const temperature = clamp(patch.temperature, TEMP_MIN, TEMP_MAX);
  const maxTokens = patch.maxTokens != null
    ? clamp(Math.round(patch.maxTokens), TOKENS_MIN, TOKENS_MAX)
    : null;

  const value = {
    provider: entry.provider,
    model: entry.model,
    temperature,
    maxTokens,
    updatedAt: new Date().toISOString(),
  };

  await env.CACHE.put(KV_KEY, JSON.stringify(value));
  return { value };
}

export function resolveLlmConfig(active, flowConfig) {
  const provider = active?.provider || 'cerebras';
  const model = active?.model || flowConfig?.model || DEFAULT_CATALOG_ENTRY.model;
  const temperature = active?.temperature
    ?? (typeof flowConfig?.temperature === 'number' ? flowConfig.temperature : 0.6);
  const maxTokens = active?.maxTokens ?? flowConfig?.maxTokens ?? 4096;
  return {
    provider, model, temperature, maxTokens,
  };
}

export const LLM_CONFIG_LIMITS = {
  temperature: { min: TEMP_MIN, max: TEMP_MAX },
  maxTokens: { min: TOKENS_MIN, max: TOKENS_MAX },
};
