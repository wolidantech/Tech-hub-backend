// Validates the PostgreSQL syntax of every migration with libpg_query.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import parser from 'pgsql-parser';

const dir = new URL('../supabase/migrations/', import.meta.url).pathname;
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

let failed = 0;
for (const file of files) {
  const sql = readFileSync(join(dir, file), 'utf8');
  try {
    await parser.parse(sql);
    console.log(`✓ ${file}`);
  } catch (err) {
    failed += 1;
    console.error(`✗ ${file}`);
    console.error(String(err).slice(0, 1200));
    // Show the offending area
    const m = /position:\s*(\d+)/i.exec(String(err));
    if (m) {
      const pos = Number(m[1]);
      console.error('\n--- near error ---');
      console.error(sql.slice(Math.max(0, pos - 220), pos + 220));
      console.error('------------------');
    }
  }
}

if (failed) {
  console.error(`\n${failed} migration(s) have SQL syntax errors.`);
  process.exit(1);
}
console.log('\nAll migrations parse cleanly.');
