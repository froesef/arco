/**
 * Cerebras provider — wraps @cerebras/cerebras_cloud_sdk with the normalized
 * async-iterable stream contract.
 */

// eslint-disable-next-line import/no-unresolved
import Cerebras from '@cerebras/cerebras_cloud_sdk';

async function* stream({
  env, model, messages, temperature, maxTokens, signal,
}) {
  if (!env.CEREBRAS_API_KEY) {
    const err = new Error('Cerebras API key is not configured.');
    err.status = 401;
    throw err;
  }
  const client = new Cerebras({ apiKey: env.CEREBRAS_API_KEY });

  const completion = await client.chat.completions.create({
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: true,
    stream_options: { include_usage: true },
  }, { signal });

  let usage = null;
  // eslint-disable-next-line no-restricted-syntax
  for await (const chunk of completion) {
    const text = chunk.choices?.[0]?.delta?.content;
    if (text) yield { type: 'delta', text };
    if (chunk.usage) usage = chunk.usage;
    if (chunk.x_cerebras?.usage) usage = chunk.x_cerebras.usage;
  }
  if (usage) yield { type: 'usage', usage };
}

export default { id: 'cerebras', stream };
