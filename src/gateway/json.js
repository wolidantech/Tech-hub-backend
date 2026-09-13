/**
 * Strict-JSON handling for LLM output: extract, repair, parse, and a
 * validate-and-retry loop (max 2 retries, then the caller returns 502).
 */

/** Pull the outermost JSON object out of text that may contain fences/prose. */
export function extractJson(text) {
  let s = String(text ?? '').trim();

  // ```json ... ``` or ``` ... ```
  const fence = s.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  if (s.startsWith('{') && s.endsWith('}')) return s;

  // First balanced { ... } block, string-aware.
  const start = s.indexOf('{');
  if (start === -1) return s;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return s.slice(start);
}

/** Best-effort repair of the common ways models break JSON. */
export function repairJson(raw) {
  let s = String(raw ?? '');
  // Trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1');
  // Strip // line comments outside strings (naive but safe enough for our shapes)
  s = s.replace(/^\s*\/\/.*$/gm, '');
  // Remove trailing ellipsis / dangling text after the final brace
  const end = s.lastIndexOf('}');
  if (end !== -1) s = s.slice(0, end + 1);
  return s;
}

/** Parse model text into an object, throwing a descriptive error on failure. */
export function parseModelJson(text) {
  const extracted = extractJson(text);
  try {
    return JSON.parse(extracted);
  } catch (firstError) {
    try {
      return JSON.parse(repairJson(extracted));
    } catch {
      const err = new Error(`Model did not return parseable JSON: ${firstError.message}`);
      err.code = 'JSON_PARSE_FAILED';
      throw err;
    }
  }
}

/**
 * Ask the provider for JSON, then validate it.
 * On parse/shape failure, retry up to `maxRetries` times with a corrective
 * instruction. Throws the last error so the caller can answer 502.
 */
export async function generateStructured(provider, { system, user, validate, maxRetries = 2, timeoutMs = 25000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let lastError;
  let prompt = user;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const text = await provider.complete({ system, user: prompt, signal: controller.signal });
      const parsed = parseModelJson(text);
      return validate ? validate(parsed) : parsed;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        prompt = `${user}\n\nYour previous reply was rejected: ${String(error.message).slice(0, 400)}\nReturn the corrected JSON object now — valid JSON only, matching the required shape exactly.`;
        await sleep(150 * (attempt + 1));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export default { extractJson, repairJson, parseModelJson, generateStructured };
