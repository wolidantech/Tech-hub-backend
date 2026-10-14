/**
 * Applies supabase/frontend-migrations/015_lecturer_workflow.sql to the
 * FRONTEND/live schema only — lecturer course assignments, draft/publish
 * content columns, content + grade moderation tables, lecturer RLS, review
 * RPCs and the private pending-resources bucket.
 *
 * Kept separate from scripts/migrate-frontend.mjs because that runner
 * supports a smaller pre-preflight fixture; this one requires the full
 * frontend LMS tables (001-011) and refuses anything else before touching SQL.
 * It deliberately never replays the legacy backend chain.
 *
 * Requires DATABASE_URL. Idempotent and tracked in the same
 * public._techhub_frontend_feature_migrations table as the main runner.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STEP = {
  name: 'frontend-015_lecturer_workflow.sql',
  path: join(ROOT, 'supabase/frontend-migrations/015_lecturer_workflow.sql'),
};
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
  await requireColumns(client, 'courses', ['id', 'title', 'published']);
  await requireColumns(client, 'course_modules', ['id', 'course_id', 'title', 'position']);
  await requireColumns(client, 'course_lessons', ['id', 'course_id', 'module_id', 'title', 'position', 'description', 'resources']);
  await requireColumns(client, 'course_content', ['id', 'lesson_id', 'body_markdown']);
  await requireColumns(client, 'course_videos', ['id', 'lesson_id', 'provider', 'status']);
  await requireColumns(client, 'quizzes', ['id', 'course_id', 'title', 'status', 'passing_score', 'allow_retake', 'attempt_limit', 'is_final']);
  await requireColumns(client, 'quiz_questions', ['id', 'quiz_id', 'type', 'question', 'options', 'correct_answer', 'correct_answers', 'accepted_answers']);
  await requireColumns(client, 'quiz_attempts', ['id', 'quiz_id', 'course_id', 'user_id']);
  await requireColumns(client, 'assignments', ['id', 'course_id', 'title', 'status', 'max_score', 'is_final_project', 'deadline', 'submission_type']);
  await requireColumns(client, 'assignment_submissions', ['id', 'assignment_id', 'course_id', 'user_id', 'status', 'score', 'feedback', 'reviewed_by', 'reviewed_at']);
  await requireColumns(client, 'enrollments', ['id', 'user_id', 'course_id', 'status']);
  await requireColumns(client, 'student_notifications', ['id', 'user_id', 'type', 'title', 'message', 'course_id']);
  await requireColumns(client, 'audit_logs', ['id', 'actor_email', 'action', 'entity_type', 'entity_id', 'details']);
  const { rows: [helpers] } = await client.query(
    `select to_regprocedure('public.is_admin()') is not null as is_admin,
            to_regclass('public._techhub_frontend_feature_migrations') is not null as tracking`
  );
  if (!helpers.is_admin) fail('Schema preflight failed: public.is_admin() is unavailable. Apply frontend migrations 001-011 (and 009) first.');
  if (!helpers.tracking) fail('Schema preflight failed: run scripts/migrate-frontend.mjs first (frontend 012-014), then this script.');
  const { rows: [storage] } = await client.query(
    `select to_regclass('storage.buckets') is not null as buckets, to_regclass('storage.objects') is not null as objects`
  );
  if (!storage.buckets || !storage.objects) fail('Schema preflight failed: supabase storage tables are unavailable.');
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail('DATABASE_URL is not configured. No database was contacted or changed.');

  const ssl = process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false };
  const client = new pg.Client({ connectionString: databaseUrl, ssl });
  await client.connect();
  try {
    await preflight(client);
    console.log('Frontend lecturer preflight passed.');

    await client.query('begin');
    try {
      const { rows } = await client.query(`select 1 from ${TRACKING_TABLE} where name=$1`, [STEP.name]);
      if (rows.length) {
        console.log(`✓ ${STEP.name} already applied`);
        await client.query('commit');
        return;
      }
      console.log(`→ applying ${STEP.name}`);
      await client.query(readFileSync(STEP.path, 'utf8'));
      await client.query(`insert into ${TRACKING_TABLE} (name) values ($1)`, [STEP.name]);
      await client.query('commit');
      console.log(`✓ ${STEP.name} — lecturer assignments, moderation and review RPCs are ready.`);
      console.log('  Deploy the gateway afterwards so the new API routes serve the frontend.');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`\nLecturer migration stopped safely: ${error.message}`);
  process.exitCode = 1;
});
