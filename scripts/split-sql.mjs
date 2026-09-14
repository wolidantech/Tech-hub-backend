/**
 * Split a large idempotent seed SQL file into N paste-friendly parts for the
 * Supabase SQL Editor (large single pastes can time out in the browser).
 *
 * Splits ONLY on statement boundaries (`;` OUTSIDE dollar-quoted strings —
 * a proper scanner, since lesson bodies contain newlines and semicolons),
 * preserving order (FK parents stay before children). Parts are
 * concatenation-verified by scripts/verify-seed-sql.mjs.
 *
 * Usage: node scripts/split-sql.mjs <file.sql> <n>
 * Output: <file>_part1.sql ... <file>_partN.sql
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [file, nStr] = process.argv.slice(2);
if (!file || !nStr) {
  console.error('Usage: node scripts/split-sql.mjs <file.sql> <n>');
  process.exit(1);
}
const n = Number(nStr);
const sql = readFileSync(file, 'utf8');

// --- Scanner: find statement boundaries (`;` outside dollar quotes) ---
// States: normal | dollar(tag) | linecomment. Single-quoted strings never
// appear in generated SQL (all literals are dollar-quoted).
const boundaries = []; // index AFTER each terminating ';'
let i = 0;
let dollarTag = null;
while (i < sql.length) {
  if (dollarTag) {
    if (sql.startsWith(dollarTag, i)) {
      i += dollarTag.length;
      dollarTag = null;
    } else {
      i += 1;
    }
    continue;
  }
  if (sql[i] === '$') {
    const m = sql.slice(i, i + 32).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$/);
    if (m) {
      dollarTag = m[0];
      i += m[0].length;
      continue;
    }
  }
  if (sql.startsWith('--', i) && (i === 0 || sql[i - 1] === '\n')) {
    const nl = sql.indexOf('\n', i);
    i = nl === -1 ? sql.length : nl + 1;
    continue;
  }
  if (sql[i] === ';') boundaries.push(i + 1);
  i += 1;
}

if (boundaries.length === 0) {
  console.error('No statements found — is this a SQL file?');
  process.exit(1);
}

// Slice statements (leading comments/blank lines stay attached to the
// statement that follows them).
const statements = [];
let prev = 0;
for (const b of boundaries) {
  statements.push(sql.slice(prev, b));
  prev = b;
}
const tail = sql.slice(prev);
if (tail.trim()) {
  console.error('Trailing non-whitespace after last statement — refusing to split.');
  process.exit(1);
}

const per = Math.ceil(statements.length / n);
const base = file.replace(/\.sql$/, '');
for (let p = 0; p < n; p += 1) {
  const chunk = statements.slice(p * per, (p + 1) * per);
  if (chunk.length === 0) continue;
  const header = p === 0
    ? `-- Part 1 of ${n} — run parts in order (1, 2, ...). Idempotent: safe to re-run.\n`
    : `-- Part ${p + 1} of ${n} — run AFTER part ${p}. Idempotent: safe to re-run.\n`;
  const body = chunk.join('').trim() + '\n';
  writeFileSync(`${base}_part${p + 1}.sql`, header + body);
  console.log(`wrote ${base}_part${p + 1}.sql (${chunk.length} statements)`);
}
console.log(`total: ${statements.length} statements in ${n} parts`);
