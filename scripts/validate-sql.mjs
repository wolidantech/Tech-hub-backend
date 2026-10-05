// Validates PostgreSQL syntax for both the legacy chain and frontend-schema add-ons.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import parser from 'pgsql-parser';

const root = fileURLToPath(new URL('../supabase/', import.meta.url));
const dirs = [
  { label: 'legacy', path: join(root, 'migrations') },
  { label: 'frontend', path: join(root, 'frontend-migrations') },
];

let failed = 0;
let total = 0;
for (const dir of dirs) {
  let files = [];
  try {
    files = readdirSync(dir.path).filter((file) => file.endsWith('.sql')).sort();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  for (const file of files) {
    total += 1;
    const sql = readFileSync(join(dir.path, file), 'utf8');
    try {
      await parser.parse(sql);
      console.log(`✓ ${dir.label}/${file}`);
    } catch (err) {
      failed += 1;
      console.error(`✗ ${dir.label}/${file}`);
      console.error(String(err).slice(0, 1200));
      const match = /position:\s*(\d+)/i.exec(String(err));
      if (match) {
        const pos = Number(match[1]);
        console.error('\n--- near error ---');
        console.error(sql.slice(Math.max(0, pos - 220), pos + 220));
        console.error('------------------');
      }
    }
  }
}

if (failed) {
  console.error(`\n${failed} of ${total} migration file(s) have SQL syntax errors.`);
  process.exit(1);
}
console.log(`\nAll ${total} migration files parse cleanly.`);
