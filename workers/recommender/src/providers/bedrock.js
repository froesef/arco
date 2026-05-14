/**
 * AWS Bedrock provider — Converse Stream API with bearer token auth.
 * Parses the AWS binary event stream and yields normalized delta/usage chunks.
 *
 * Required secret: AWS_BEARER_TOKEN_BEDROCK
 * Optional var:    AWS_REGION (default: us-east-1)
 */

const decoder = new TextDecoder();

// --- AWS binary event stream parser ---
// Frame layout: [4B totalLen][4B headersLen][4B preludeCRC][headers][payload][4B messageCRC]
async function* parseEventStream(response, signal) {
  const reader = response.body.getReader();
  let buf = new Uint8Array(0);

  try {
    while (true) {
      if (signal?.aborted) break;
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await reader.read();
      if (done) break;

      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;

      while (buf.length >= 12) {
        const view = new DataView(buf.buffer, buf.byteOffset);
        const totalLen = view.getUint32(0);
        const headersLen = view.getUint32(4);
        if (buf.length < totalLen) break;

        const headersStart = 12;
        const payloadStart = headersStart + headersLen;
        const payloadLen = totalLen - headersLen - 16;

        // Parse headers: [1B nameLen][name][1B valueType=7][2B valueLen][value]
        const headers = {};
        let pos = headersStart;
        while (pos < payloadStart) {
          const nameLen = buf[pos]; pos += 1;
          const name = decoder.decode(buf.slice(pos, pos + nameLen));
          pos += nameLen;
          const valueType = buf[pos]; pos += 1;
          if (valueType === 7) {
            // eslint-disable-next-line no-bitwise
            const valueLen = (buf[pos] << 8) | buf[pos + 1];
            pos += 2;
            headers[name] = decoder.decode(buf.slice(pos, pos + valueLen));
            pos += valueLen;
          } else {
            break;
          }
        }

        if (headers[':event-type']) {
          const payloadBytes = buf.slice(payloadStart, payloadStart + payloadLen);
          try {
            yield {
              eventType: headers[':event-type'],
              payload: JSON.parse(decoder.decode(payloadBytes)),
            };
          } catch {
            // ignore malformed payload
          }
        }

        buf = buf.slice(totalLen);
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

async function* stream({
  env, model, messages, temperature, maxTokens, signal,
}) {
  const token = env.AWS_BEARER_TOKEN_BEDROCK;
  const region = env.AWS_REGION || 'us-east-1';

  if (!token) {
    const err = new Error('AWS Bedrock bearer token not configured. Set the AWS_BEARER_TOKEN_BEDROCK secret.');
    err.status = 401;
    throw err;
  }

  const systemParts = messages.filter((m) => m.role === 'system').map((m) => ({ text: m.content }));
  const turnMessages = messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role,
    content: [{ type: 'text', text: m.content }],
  }));

  const body = {
    messages: turnMessages,
    inferenceConfig: { maxTokens, temperature },
  };
  if (systemParts.length) {
    body.system = [...systemParts, { cachePoint: { type: 'default' } }];
  }

  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse-stream`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/vnd.amazon.eventstream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    const err = new Error(`Bedrock request failed (${response.status}): ${errBody.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  // eslint-disable-next-line no-restricted-syntax
  for await (const event of parseEventStream(response, signal)) {
    if (event.eventType === 'contentBlockDelta') {
      const text = event.payload?.delta?.text;
      if (text) yield { type: 'delta', text };
    } else if (event.eventType === 'metadata') {
      const usage = event.payload?.usage;
      if (usage) {
        inputTokens = usage.inputTokens || 0;
        outputTokens = usage.outputTokens || 0;
        cacheReadTokens = usage.cacheReadInputTokenCount || 0;
        cacheWriteTokens = usage.cacheWriteInputTokenCount || 0;
      }
    }
  }

  if (inputTokens || outputTokens) {
    yield {
      type: 'usage',
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_write_tokens: cacheWriteTokens,
      },
    };
  }
}

export default { id: 'bedrock', stream };
