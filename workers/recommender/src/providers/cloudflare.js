/**
 * Cloudflare Workers AI provider — uses the env.AI binding.
 *
 * When called with stream:true, env.AI.run returns a ReadableStream of
 * Server-Sent Events in the shape: `data: { "response": "...", "usage"?: {} }`.
 * The terminal frame is `data: [DONE]`.
 */

async function* iterateSse(readable) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
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
  if (!env.AI) {
    const err = new Error('Cloudflare AI binding is not configured.');
    err.status = 500;
    throw err;
  }

  const onAbort = () => {
    // env.AI.run doesn't accept AbortSignal directly; consumer aborts via signal
    // on the outer for-await loop which stops pulling from the stream.
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const result = await env.AI.run(model, {
    messages,
    stream: true,
    max_tokens: maxTokens,
    temperature,
  });

  // env.AI.run returns a ReadableStream when stream:true.
  const readable = result instanceof ReadableStream ? result : result?.readable;
  if (!readable) {
    throw new Error('Cloudflare AI did not return a stream.');
  }

  let usage = null;
  // eslint-disable-next-line no-restricted-syntax
  for await (const evt of iterateSse(readable)) {
    if (signal?.aborted) break;
    const text = typeof evt.response === 'string'
      ? evt.response
      : evt.choices?.[0]?.delta?.content;
    if (text) yield { type: 'delta', text };
    if (evt.usage) {
      const prompt = evt.usage.prompt_tokens ?? evt.usage.input_tokens ?? null;
      const completion = evt.usage.completion_tokens ?? evt.usage.output_tokens ?? null;
      const total = evt.usage.total_tokens
        ?? (((prompt ?? 0) + (completion ?? 0)) || null);
      usage = {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: total,
      };
    }
  }
  if (usage) yield { type: 'usage', usage };
}

export default { id: 'cloudflare', stream };
