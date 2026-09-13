/**
 * Lightweight sanity check: verifies every source file parses and both
 * Express apps can be constructed (without network calls to Supabase or an
 * LLM provider).
 * Usage: npm run check
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.SKIP_ENV_VALIDATION ||= 'true';

function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = [...collect('src'), ...collect('scripts')];
let failed = 0;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`✗ ${file}\n${result.stderr}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} file(s) failed the syntax check.`);
  process.exit(1);
}

// ---- the deployed service: the Secure AI Gateway ----
const { createApp } = await import('../src/gateway/app.js');
const { createProvider } = await import('../src/gateway/providers/index.js');
const { createSupabase } = await import('../src/gateway/supabase.js');
const { createAuth } = await import('../src/gateway/auth.js');

const stubConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiKey: 'check',
  baseUrl: '',
  maxTokens: 100,
  temperature: 0.7,
  aiTimeoutMs: 5000,
  maxRetries: 2,
  supabaseUrl: 'https://check.invalid',
  supabaseServiceRoleKey: 'check',
  allowedOrigins: ['https://check.invalid'],
  chatRateLimit: 30,
  generateRateLimit: 10,
  rateWindowMs: 60000,
  maxMessageChars: 4000,
  maxHistory: 12,
  ragMaxDocs: 6,
  ragMaxCharsPerDoc: 2000,
};
const stubFetch = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' });
const supabase = createSupabase({ url: stubConfig.supabaseUrl, serviceKey: 'check', fetchImpl: stubFetch });
const gateway = createApp({
  config: stubConfig,
  provider: createProvider(stubConfig, { fetchImpl: stubFetch }),
  supabase,
  auth: createAuth({ supabaseUrl: stubConfig.supabaseUrl, serviceKey: 'check', supabase, fetchImpl: stubFetch }),
  logger: { info() {}, warn() {}, error() {} },
});
if (typeof gateway !== 'function') {
  console.error('Secure AI Gateway app failed to load.');
  process.exit(1);
}

// ---- the legacy LMS backend (kept for reference, not deployed) ----
const { default: lmsApp } = await import('../src/app.js');
if (typeof lmsApp !== 'function') {
  console.error('Legacy LMS app failed to load.');
  process.exit(1);
}

// ---- runtime compatibility: Supabase clients must construct WITHOUT a native WebSocket ----
// Node.js 21+ ships a global WebSocket; `--no-experimental-websocket` removes
// it so this machine reproduces Node.js 18/20, where realtime-js throws
// inside createClient() and killed the deploy. Node.js <= 20 needs no flag.
const nodeMajor = Number(process.versions.node.split('.')[0]);
const runtimeFlags = nodeMajor >= 21 ? ['--no-experimental-websocket'] : [];
const runtimeCheck = spawnSync(process.execPath, [...runtimeFlags, join('scripts', 'check-runtime.mjs')], {
  encoding: 'utf8',
});
if (runtimeCheck.status !== 0) {
  console.error('✗ Supabase clients fail to construct on a runtime without a native WebSocket (Node.js < 22).');
  console.error((runtimeCheck.stdout || '') + (runtimeCheck.stderr || ''));
  process.exit(1);
}
process.stdout.write(runtimeCheck.stdout || '');

console.log(`✓ ${files.length} files parsed successfully; AI gateway + legacy LMS app both assemble.`);
