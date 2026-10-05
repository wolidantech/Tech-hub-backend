/**
 * Applies the SQL migrations in supabase/migrations/ in order.
 *
 * Requires DATABASE_URL (Project Settings -> Database in Supabase):
 *   postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres
 *
 * Usage:  npm run migrate
 *
 * Alternative: with the Supabase CLI installed you can also run
 *   supabase link --project-ref <ref> && supabase db push
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Client } = pg;
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL is not set. See .env.example for the expected format.');
    process.exit(1);
  }

  const ssl = process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false };
  const client = new Client({ connectionString: databaseUrl, ssl });

  await client.connect();
  const { rows: [schema] } = await client.query(`
    select to_regclass('public.profiles') is not null as has_profiles,
           to_regclass('public.course_categories') is not null as has_legacy_categories,
           exists (select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='user_id') as has_legacy_user_id,
           exists (select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='profile_photo_url') as has_legacy_photo,
           exists (select 1 from information_schema.columns where table_schema='public' and table_name='courses' and column_name='is_published') as has_legacy_course_publish
  `);
  if (schema.has_profiles && (!schema.has_legacy_categories || !schema.has_legacy_user_id
      || !schema.has_legacy_photo || !schema.has_legacy_course_publish)) {
    throw new Error(
      'Target schema does not match this legacy migration chain. No SQL was applied. ' +
      'For the frontend schema, apply frontend migrations 001-011 and use npm run migrate:frontend; ' +
      'do not run the full legacy npm run migrate chain there.'
    );
  }
  console.log('Connected to a compatible legacy-schema target.\n');

  await client.query(`
    create table if not exists public._migrations (
      name        text primary key,
      executed_at timestamptz not null default now()
    );
    alter table public._migrations enable row level security;
    revoke all on public._migrations from anon, authenticated;
    grant all on public._migrations to service_role;
  `);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const { rows } = await client.query('select 1 from public._migrations where name = $1', [file]);
    if (rows.length > 0) {
      console.log(`  ✓ ${file} (already applied)`);
      continue;
    }

    console.log(`  → applying ${file} ...`);
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    await client.query(sql);
    await client.query('insert into public._migrations (name) values ($1)', [file]);
    console.log(`  ✓ ${file}`);
  }

  console.log('\nAll migrations applied.');
  await client.end();
}

main().catch((err) => {
  console.error('\nMigration failed:', err.message);
  console.error(err.detail || '');
  process.exit(1);
});
