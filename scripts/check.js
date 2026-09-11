/**
 * Lightweight sanity check: verifies every source file parses and the
 * Express app can be constructed (without network calls to Supabase).
 * Usage: SKIP_ENV_VALIDATION=true npm run check
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

const { default: app } = await import('../src/app.js');
if (typeof app !== 'function') {
  console.error('Express app failed to load.');
  process.exit(1);
}

console.log(`✓ ${files.length} files parsed successfully and the app assembles.`);
