/**
 * Unit tests for the dynamic model catalog. Local providers (ollama/vllm)
 * should resolve their real served model ids from the live server instead of
 * showing the static `served-model` placeholder. Network is mocked.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getCatalog } from '../../src/providers/index.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('getCatalog — no local providers configured keeps static catalog', async () => {
  globalThis.fetch = async () => { throw new Error('should not be called'); };
  const catalog = await getCatalog({});
  assert.ok(catalog.some((e) => e.provider === 'cerebras'));
  // Static placeholder remains when VLLM_BASE_URL is unset.
  assert.ok(catalog.some((e) => e.provider === 'vllm' && e.model === 'served-model'));
});

test('getCatalog — vLLM resolves the real served model id', async () => {
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/v1\/models$/);
    return new Response(JSON.stringify({ data: [{ id: 'mlx-community/diffusiongemma-26B-A4B-it-4bit' }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  const catalog = await getCatalog({ VLLM_BASE_URL: 'http://localhost:8000/v1' });
  assert.ok(!catalog.some((e) => e.model === 'served-model'), 'placeholder removed');
  assert.ok(
    catalog.some((e) => e.provider === 'vllm' && e.model === 'mlx-community/diffusiongemma-26B-A4B-it-4bit'),
    'real model present',
  );
});

test('getCatalog — vLLM server unreachable falls back to placeholder', async () => {
  globalThis.fetch = async () => { throw new Error('connection refused'); };
  const catalog = await getCatalog({ VLLM_BASE_URL: 'http://localhost:8000/v1' });
  assert.ok(catalog.some((e) => e.provider === 'vllm' && e.model === 'served-model'));
});

test('getCatalog — Ollama resolves served models from /api/tags', async () => {
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/api\/tags$/);
    return new Response(JSON.stringify({ models: [{ name: 'gemma4:12b' }, { name: 'qwen3:8b' }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  const catalog = await getCatalog({ OLLAMA_BASE_URL: 'http://localhost:11434' });
  const ollamaModels = catalog.filter((e) => e.provider === 'ollama').map((e) => e.model);
  assert.deepEqual(ollamaModels, ['gemma4:12b', 'qwen3:8b']);
});
