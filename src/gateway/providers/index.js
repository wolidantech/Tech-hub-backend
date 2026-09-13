/**
 * Provider abstraction — OpenAI | Anthropic | Gemini, swappable through
 * AI_PROVIDER / AI_MODEL without touching a single route.
 *
 * Implemented directly over HTTPS (global fetch, Node 18+) so the service
 * carries no vendor SDK. `fetchImpl` is injectable for tests.
 *
 * Two methods:
 *   complete({ system, user })  -> strict JSON text (AI Studio generation)
 *   chat({ system, messages })  -> plain markdown text (DanTECH AI)
 */

class ProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

async function readError(res, label) {
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    /* ignore */
  }
  // The key is never echoed back; upstream bodies are trimmed.
  throw new ProviderError(`${label} request failed (${res.status})${detail ? `: ${detail}` : ''}`, res.status);
}

/** Keep only well-formed turns, newest last, bounded in size. */
export function sanitizeHistory(history, { maxTurns = 12, maxChars = 2000 } = {}) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof (m.text ?? m.content) === 'string')
    .slice(-maxTurns)
    .map((m) => ({ role: m.role, content: String(m.text ?? m.content).slice(0, maxChars) }));
}

// ------------------------------------------------------------------ OpenAI
function openaiProvider(opts) {
  const endpoint = `${opts.baseUrl || 'https://api.openai.com/v1'}/chat/completions`;
  async function call(body, signal) {
    const res = await opts.fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(body),
      signal: signal || opts.signal,
    });
    if (!res.ok) await readError(res, 'OpenAI');
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new ProviderError('OpenAI returned an empty completion', 502);
    return text;
  }
  return {
    name: 'openai',
    model: opts.model,
    complete({ system, user, signal }) {
      return call(
        {
          model: opts.model,
          temperature: opts.temperature,
          max_tokens: opts.maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
        signal
      );
    },
    chat({ system, messages, signal }) {
      return call(
        {
          model: opts.model,
          temperature: opts.temperature,
          max_tokens: opts.maxTokens,
          messages: [{ role: 'system', content: system }, ...messages],
        },
        signal
      );
    },
  };
}

// ---------------------------------------------------------------- Anthropic
function anthropicProvider(opts) {
  async function call(body, signal) {
    const res = await opts.fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: signal || opts.signal,
    });
    if (!res.ok) await readError(res, 'Anthropic');
    const data = await res.json();
    const text = (data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!text) throw new ProviderError('Anthropic returned an empty completion', 502);
    return text;
  }
  return {
    name: 'anthropic',
    model: opts.model,
    complete({ system, user, signal }) {
      return call(
        {
          model: opts.model,
          temperature: opts.temperature,
          max_tokens: opts.maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
        },
        signal
      );
    },
    chat({ system, messages, signal }) {
      return call({ model: opts.model, temperature: opts.temperature, max_tokens: opts.maxTokens, system, messages }, signal);
    },
  };
}

// ------------------------------------------------------------------- Gemini
function geminiProvider(opts) {
  const endpoint = `${opts.baseUrl || 'https://generativelanguage.googleapis.com/v1beta'}/models/${opts.model}:generateContent?key=${opts.apiKey}`;
  async function call(body, signal) {
    const res = await opts.fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal || opts.signal,
    });
    if (!res.ok) await readError(res, 'Gemini');
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
    if (!text) throw new ProviderError('Gemini returned an empty completion', 502);
    return text;
  }
  return {
    name: 'gemini',
    model: opts.model,
    complete({ system, user, signal }) {
      return call(
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: {
            temperature: opts.temperature,
            maxOutputTokens: opts.maxTokens,
            responseMimeType: 'application/json',
          },
        },
        signal
      );
    },
    chat({ system, messages, signal }) {
      return call(
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: messages.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          generationConfig: { temperature: opts.temperature, maxOutputTokens: opts.maxTokens },
        },
        signal
      );
    },
  };
}

const FACTORIES = { openai: openaiProvider, anthropic: anthropicProvider, gemini: geminiProvider };

export function createProvider(cfg, { fetchImpl = globalThis.fetch } = {}) {
  const factory = FACTORIES[cfg.provider];
  if (!factory) throw new Error(`Unsupported AI_PROVIDER: ${cfg.provider}`);
  return factory({
    model: cfg.model,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    maxTokens: cfg.maxTokens,
    temperature: cfg.temperature,
    fetchImpl,
  });
}

export { ProviderError };
export default createProvider;
