/**
 * Applies only the additive migrations designed for the live frontend schema:
 *   1. supabase/frontend-migrations/012_catalogue_expansion.sql
 *   2. supabase/migrations/20261005000017_jamb_cbt_engine.sql
 *   3. supabase/frontend-migrations/014_danqel_brand_identity.sql
 *
 * It deliberately does NOT replay the legacy 001-018 chain and does not apply
 * the legacy student-ID migration 018 (frontend migration 011 owns that table).
 * Requires DATABASE_URL and an exact schema preflight before making changes.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STEPS = [
  {
    name: 'frontend-012_catalogue_expansion.sql',
    path: join(ROOT, 'supabase/frontend-migrations/012_catalogue_expansion.sql'),
  },
  {
    name: 'frontend-013_jamb_cbt_engine.sql',
    path: join(ROOT, 'supabase/migrations/20261005000017_jamb_cbt_engine.sql'),
  },
  {
    name: 'frontend-014_danqel_brand_identity.sql',
    path: join(ROOT, 'supabase/frontend-migrations/014_danqel_brand_identity.sql'),
  },
];
const TRACKING_TABLE = 'public._techhub_frontend_feature_migrations';

function fail(message) {
  throw new Error(message);
}

async function requireColumns(client, table, columns) {
  const { rows } = await client.query(
    `select column_name from information_schema.columns
      where table_schema='public' and table_name=$1 and column_name = any($2::text[])`,
    [table, columns]
  );
  const found = new Set(rows.map((row) => row.column_name));
  const missing = columns.filter((column) => !found.has(column));
  if (missing.length) fail(`Schema preflight failed: public.${table} is missing ${missing.join(', ')}.`);
}

async function preflight(client) {
  await requireColumns(client, 'profiles', ['id', 'full_name', 'email', 'role', 'avatar_url']);
  await requireColumns(client, 'categories', ['id', 'name', 'sort_order']);
  await requireColumns(client, 'courses', ['id', 'slug', 'title', 'category', 'price', 'published']);
  await requireColumns(client, 'bundles', ['id', 'title', 'course_ids', 'price', 'is_published', 'kind']);
  await requireColumns(client, 'manual_payments', ['user_id', 'bundle_id', 'status']);
  await requireColumns(client, 'student_id_cards', ['user_id', 'card_number', 'photo_path', 'status']);
  await requireColumns(client, 'site_settings', ['id', 'site_name', 'tagline', 'meta_description', 'support_email', 'account_name', 'dantech_enabled']);
  await requireColumns(client, 'certificate_issues', ['certificate_id', 'verification_code', 'user_id', 'course_id', 'status', 'issued_by', 'issue_date']);
  await requireColumns(client, 'student_notifications', ['user_id', 'type', 'title', 'message', 'read', 'created_at']);
  const { rows: [isAdmin] } = await client.query(`select to_regprocedure('public.is_admin()') is not null as ready`);
  if (!isAdmin.ready) fail('Schema preflight failed: public.is_admin() is unavailable. Apply frontend migrations 001-011 first.');
  const { rows: [roles] } = await client.query(
    `select to_regrole('anon') is not null as anon,
            to_regrole('authenticated') is not null as authenticated,
            to_regrole('service_role') is not null as service_role`
  );
  if (!roles.anon || !roles.authenticated || !roles.service_role) {
    fail('Schema preflight failed: Supabase roles anon, authenticated and service_role are required.');
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    fail('DATABASE_URL is not configured. No database was contacted or changed.');
  }

  const ssl = process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false };
  const client = new pg.Client({ connectionString: databaseUrl, ssl });
  await client.connect();
  try {
    await preflight(client);
    console.log('Frontend schema preflight passed.');

    await client.query('begin');
    try {
      await client.query(`
        create table if not exists ${TRACKING_TABLE} (
          name text primary key,
          executed_at timestamptz not null default now()
        );
        alter table ${TRACKING_TABLE} enable row level security;
        revoke all on ${TRACKING_TABLE} from anon, authenticated;
      `);

      for (const step of STEPS) {
        const { rows } = await client.query(`select 1 from ${TRACKING_TABLE} where name=$1`, [step.name]);
        if (rows.length) {
          console.log(`✓ ${step.name} already applied`);
          continue;
        }
        console.log(`→ applying ${step.name}`);
        await client.query(readFileSync(step.path, 'utf8'));
        await client.query(`insert into ${TRACKING_TABLE} (name) values ($1)`, [step.name]);
        console.log(`✓ ${step.name}`);
      }
      await client.query('commit');
      console.log('Frontend catalogue, JAMB and brand migrations applied. JAMB pass and exams remain unpublished until reviewed.');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`\nMigration stopped safely: ${error.message}`);
  process.exitCode = 1;
});
