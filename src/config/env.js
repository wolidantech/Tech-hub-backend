import dotenv from 'dotenv';

dotenv.config();

/**
 * Environment validation.
 *
 * Every required variable is checked in a single pass so that a broken
 * deployment reports the COMPLETE list of missing values at once instead of
 * crashing on the first one, being restarted, and then crashing on the next
 * one (which produces an endless crash/restart loop in the host's logs).
 */
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

const isTest = process.env.SKIP_ENV_VALIDATION === 'true';

export const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  isProduction: optional('NODE_ENV', 'development') === 'production',

  port: Number(optional('PORT', '5000')) || 5000,

  supabaseUrl: isTest ? optional('SUPABASE_URL', 'http://localhost:54321') : required('SUPABASE_URL'),
  supabaseAnonKey: isTest ? optional('SUPABASE_ANON_KEY', 'anon-placeholder') : required('SUPABASE_ANON_KEY'),
  supabaseServiceRoleKey: isTest
    ? optional('SUPABASE_SERVICE_ROLE_KEY', 'service-placeholder')
    : required('SUPABASE_SERVICE_ROLE_KEY'),

  frontendUrls: optional('FRONTEND_URL', 'http://localhost:5173')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean),

  databaseUrl: optional('DATABASE_URL'),

  adminEmail: optional('ADMIN_EMAIL', 'wolidantech@gmail.com'),
  adminInitialPassword: optional('ADMIN_INITIAL_PASSWORD'),

  autoConfirmEmail: optional('AUTO_CONFIRM_EMAIL', 'false') === 'true',

  maxReceiptSizeMb: Number(optional('MAX_RECEIPT_SIZE_MB', '5')),
  maxResourceSizeMb: Number(optional('MAX_RESOURCE_SIZE_MB', '20')),
};

// ---------------------------------------------------------------------------
// Fail fast, but with a message that tells you exactly what to do.
// ---------------------------------------------------------------------------
if (!isTest) {
  // Normalise the project URL (no trailing slash) before anything uses it.
  if (env.supabaseUrl) {
    env.supabaseUrl = env.supabaseUrl.replace(/\/+$/, '');

    if (!/^https?:\/\/[^\s/]+\.[^\s/]+/.test(env.supabaseUrl)) {
      problems.push(
        `SUPABASE_URL is not a valid URL: "${env.supabaseUrl}" ` +
          '(expected e.g. https://your-project-ref.supabase.co)'
      );
    }
  }

  // Catch values copy/pasted straight out of .env.example.
  const placeholders = [
    ['SUPABASE_URL', env.supabaseUrl, 'your-project-ref'],
    ['SUPABASE_ANON_KEY', env.supabaseAnonKey, 'your-anon-public-key'],
    ['SUPABASE_SERVICE_ROLE_KEY', env.supabaseServiceRoleKey, 'your-service-role-key'],
  ];
  for (const [name, value, marker] of placeholders) {
    if (value && value.includes(marker)) {
      problems.push(
        `${name} still contains the placeholder from .env.example ("${marker}"). ` +
          'Copy the real value from Supabase → Project Settings → API.'
      );
    }
  }

  if (missing.length > 0 || problems.length > 0) {
    const lines = [];
    lines.push('');
    lines.push('✗ WOLI DAN TECH HUB API failed to start — invalid environment configuration.');
    lines.push('');
    if (missing.length > 0) {
      lines.push(`  Missing required environment variable${missing.length > 1 ? 's' : ''}:`);
      for (const name of missing) lines.push(`    • ${name}`);
    }
    if (problems.length > 0) {
      if (missing.length > 0) lines.push('');
      lines.push('  Invalid values:');
      for (const problem of problems) lines.push(`    • ${problem}`);
    }
    lines.push('');
    lines.push('  How to fix it:');
    lines.push('    Railway → your service → Variables → "+ New Variable", add each one,');
    lines.push('    then redeploy. The same applies to Render/Heroku/Fly ("Environment").');
    lines.push('    Locally, copy .env.example to .env and fill in the values.');
    lines.push('');
    lines.push('  Values come from Supabase → Project Settings → API (URL, anon key,');
    lines.push('  service_role key). The service role key is a SECRET: server side only.');
    lines.push('');
    throw new Error(lines.join('\n'));
  }
}

// Bucket names used across the application
export const BUCKETS = {
  receipts: 'payment-receipts', // private - signed URLs only
  certificates: 'certificates', // private - signed URLs only
  lessonResources: 'lesson-resources', // private - signed URLs only
  courseVideos: 'course-videos', // private - signed URLs only
  courseResources: 'course-resources', // private - signed URLs only
  submissions: 'assignment-submissions', // private - signed URLs only
  avatars: 'avatars', // public
  courseThumbnails: 'course-thumbnails', // public
  lessonThumbnails: 'lesson-thumbnails', // public
};

export const RECEIPT_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

export default env;
