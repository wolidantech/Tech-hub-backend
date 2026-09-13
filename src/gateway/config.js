/**
 * WOLI DAN TECH HUB — Secure AI Gateway configuration.
 *
 * Self-contained on purpose: the gateway is the ONLY service deployed to
 * Railway, so it validates exactly the variables it needs and nothing else.
 * Secrets live in Railway Variables only — never in code, git, logs or
 * responses.
 */
import dotenv from 'dotenv';

dotenv.config();

const missing = [];
const problems = [];

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    missing.push(name);
    return '';
  }
  return value.trim();
}

function optional(name, fallback = '') {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

function optionalNumber(name, fallback) {
  const n = Number(optional(name, String(fallback)));
  return Number.isFinite(n) ? n : fallback;
}

const PROVIDERS = ['openai', 'anthropic', 'gemini'];
const DEFAULT_MODEL = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  gemini: 'gemini-1.5-flash',
};
/** Which secret each provider needs. */
const PROVIDER_KEY_VAR = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

const isTest = process.env.SKIP_ENV_VALIDATION === 'true';

const provider = isTest ? optional('AI_PROVIDER', 'openai') : required('AI_PROVIDER');

export const config = {
  nodeEnv: optional('NODE_ENV', 'development'),
  isProduction: optional('NODE_ENV', 'development') === 'production',
  port: optionalNumber('PORT', 5000),

  // ---- LLM provider ----
  provider: provider.toLowerCase(),
  model: optional('AI_MODEL', DEFAULT_MODEL[provider.toLowerCase()] || DEFAULT_MODEL.openai),
  apiKey: isTest ? optional(PROVIDER_KEY_VAR[provider.toLowerCase()] || 'OPENAI_API_KEY', 'test-key') : required(PROVIDER_KEY_VAR[provider.toLowerCase()] || 'OPENAI_API_KEY'),
  baseUrl: optional('AI_BASE_URL', ''),
  maxTokens: optionalNumber('AI_MAX_TOKENS', 4000),
  temperature: optionalNumber('AI_TEMPERATURE', 0.7),
  // Must stay comfortably under the frontend's 30s abort.
  aiTimeoutMs: optionalNumber('AI_TIMEOUT_MS', 25000),
  maxRetries: optionalNumber('AI_MAX_RETRIES', 2),

  // ---- Supabase (service role stays server-side, never proxied) ----
  supabaseUrl: isTest ? optional('SUPABASE_URL', 'http://localhost:54321') : required('SUPABASE_URL'),
  supabaseServiceRoleKey: isTest
    ? optional('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key')
    : required('SUPABASE_SERVICE_ROLE_KEY'),

  // ---- CORS ----
  allowedOrigins: optional('ALLOWED_ORIGINS', isTest ? 'http://localhost:5173' : '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean),

  // ---- Limits ----
  chatRateLimit: optionalNumber('CHAT_RATE_LIMIT', 30),
  generateRateLimit: optionalNumber('GENERATE_RATE_LIMIT', 10),
  rateWindowMs: optionalNumber('RATE_WINDOW_MS', 60000),
  maxMessageChars: optionalNumber('MAX_MESSAGE_CHARS', 4000),
  maxHistory: optionalNumber('MAX_HISTORY', 12),

  // ---- RAG ----
  ragMaxDocs: optionalNumber('RAG_MAX_DOCS', 6),
  ragMaxCharsPerDoc: optionalNumber('RAG_MAX_CHARS_PER_DOC', 2000),
};

if (!isTest) {
  if (!PROVIDERS.includes(config.provider)) {
    problems.push(`AI_PROVIDER must be one of ${PROVIDERS.join(', ')} (got "${config.provider}").`);
  }
  if (config.allowedOrigins.length === 0) {
    problems.push('ALLOWED_ORIGINS is required — a comma-separated list of frontend origins.');
  }
  if (config.supabaseUrl && !/^https?:\/\/[^\s/]+\.[^\s/]+/.test(config.supabaseUrl)) {
    problems.push(`SUPABASE_URL is not a valid URL: "${config.supabaseUrl}".`);
  }
  if (config.supabaseUrl) config.supabaseUrl = config.supabaseUrl.replace(/\/+$/, '');
  if (config.aiTimeoutMs >= 30000) {
    problems.push('AI_TIMEOUT_MS must be < 30000 — the frontend aborts the chat request at 30s.');
  }

  if (missing.length > 0 || problems.length > 0) {
    const lines = [''];
    lines.push('✗ WOLI DAN TECH HUB AI gateway failed to start — invalid configuration.');
    lines.push('');
    if (missing.length > 0) {
      lines.push(`  Missing required variable${missing.length > 1 ? 's' : ''}:`);
      for (const name of missing) lines.push(`    • ${name}`);
    }
    if (problems.length > 0) {
      if (missing.length > 0) lines.push('');
      lines.push('  Invalid values:');
      for (const p of problems) lines.push(`    • ${p}`);
    }
    lines.push('');
    lines.push('  Railway → your service → Variables → "+ New Variable", then redeploy.');
    lines.push('  Locally: copy .env.example to .env and fill in the values.');
    lines.push('');
    throw new Error(lines.join('\n'));
  }
}

export const DANTECH_NAME = 'DanTECH AI';
export const PLATFORM = 'WOLI DAN TECH HUB';

export default config;
