#!/usr/bin/env node
/**
 * Prints every environment variable the API reads, with secrets masked.
 *
 * Run it inside the deployment to see exactly what Railway is handing the
 * process (useful when the service crash-loops):
 *
 *   railway run npm run check:env        # on Railway
 *   npm run check:env                    # locally
 *
 * Exits non-zero (with a full report) when required variables are missing.
 */
import { configReport, default as env } from '../src/config/env.js';

const rows = configReport();
const width = Math.max(...rows.map((row) => row.setting.length));

console.log('');
console.log('  WOLI DAN TECH HUB — resolved configuration');
console.log('  ------------------------------------------');
for (const row of rows) {
  console.log(`  ${row.setting.padEnd(width)}  ${row.variable.padEnd(28)}  ${row.value}`);
}
console.log('');
console.log(`  NODE_ENV: ${env.nodeEnv}   PORT: ${env.port}   Supabase: ${env.supabaseUrl}`);
console.log(`  Allowed CORS origins: ${env.frontendUrls.join(', ') || '(none)'}`);
console.log('');
console.log('  ✓ All required environment variables are set.');
console.log('');
