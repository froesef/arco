/**
 * SambaNova provider — OpenAI-compatible /v1/chat/completions over HTTPS.
 * Parses Server-Sent Events and yields normalized delta/usage chunks.
 */

const ENDPOINT = 'https://api.sambanova.ai/v1/chat/completions';

async function* iterateSse(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) break;
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      // eslint-disable-next-line no-restricted-syntax
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue; // eslint-disable-line no-continue
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue; // eslint-disable-line no-continue
        try {
          yield JSON.parse(data);
        } catch {
          // ignore malformed frame
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

async function* stream({
  env, model, messages, temperature, maxTokens, signal,
}) {
  if (!env.SAMBANOVA_API_KEY) {
    const err = new Error('SambaNova API key is not configured.');
    err.status = 401;
    throw err;
  }

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.SAMBANOVA_API_KEY}`,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`SambaNova request failed (${response.status}): ${body.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  let usage = null;
  const iter = iterateSse(response, signal);
  // eslint-disable-next-line no-restricted-syntax
  for await (const evt of iter) {
    const text = evt.choices?.[0]?.delta?.content;
    if (text) yield { type: 'delta', text };
    if (evt.usage) usage = evt.usage;
  }
  if (usage) yield { type: 'usage', usage };
}

export default { id: 'sambanova', stream };
