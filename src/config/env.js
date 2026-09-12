import dotenv from 'dotenv';

dotenv.config();

/**
 * Central environment configuration.
 *
 * Design goals (this module runs before Express exists, so it must be
 * self-sufficient):
 *   1. Report EVERY missing/invalid variable at once — not just the first one.
 *   2. Print an actionable, human-readable report instead of a raw ESM stack
 *      trace, so a failing deploy is diagnosable from the platform logs.
 *   3. Never leak secret values into the logs.
 */

const isProduction = (process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
const skipRequested = (process.env.SKIP_ENV_VALIDATION || '').trim().toLowerCase() === 'true';

// SKIP_ENV_VALIDATION is an escape hatch for local tooling (scripts/check.js
// builds the app without a database). It is deliberately ignored in production:
// booting a "healthy" API that cannot reach Supabase is worse than failing fast.
const validationSkipped = skipRequested && !isProduction;

/** @type {{title: string, detail: string}[]} fatal configuration problems */
const problems = [];
/** @type {string[]} non-fatal, but worth shouting about */
const warnings = [];
/** @type {{key: string, variable: string, value: string}[]} for `npm run check:env` */
const resolved = [];

const PLACEHOLDER_RE = /your-|placeholder|changeme|xxxx|example\.com|<[^>]*>/i;

/**
 * Reads the first non-empty variable out of a list of accepted names and
 * tidies the value (trim, strip quotes pasted in from a dashboard).
 */
function read(names) {
  for (const name of names) {
    const raw = process.env[name];
    if (typeof raw !== 'string' || raw.trim() === '') continue;

    let value = raw.trim();
    const quoted = value.match(/^(['"])([\s\S]*)\1$/);
    if (quoted) {
      value = quoted[2].trim();
      warnings.push(
        `${name} is wrapped in quotes. Remove them — the quotes are treated as part of the value on most platforms.`
      );
    }
    return { name, value };
  }
  return null;
}

function mask(value) {
  if (!value) return '(not set)';
  if (value.length <= 12) return `${value.slice(0, 2)}…${'*'.repeat(6)}`;
  return `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`;
}

/**
 * @param {string}                    key        key on the exported `env` object
 * @param {{canonical: string, aliases?: string[], fallback?: string,
 *          hint: string, example?: string}} spec
 */
function resolve(key, spec) {
  const names = [spec.canonical, ...(spec.aliases || [])];
  const found = read(names);

  if (!found) {
    if (!validationSkipped) {
      problems.push({
        title: `${spec.canonical} is missing`,
        detail: [
          `Where to get it: ${spec.hint}`,
          spec.example ? `Example:         ${spec.example}` : null,
          spec.aliases?.length ? `Also accepted as: ${spec.aliases.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join('\n     '),
      });
      return '';
    }
    return spec.fallback || '';
  }

  if (found.name !== spec.canonical) {
    warnings.push(`${spec.canonical} is not set — falling back to ${found.name}.`);
  }

  resolved.push({ key: key.toLowerCase(), variable: found.name, value: found.value });
  return found.value;
}

/** Decodes the `role` claim of a Supabase JWT. Returns null for non-JWT keys. */
function jwtRole(token) {
  const payload = token.split('.')[1];
  if (!payload) return null; // new-style sb_publishable_/sb_secret_ keys
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof decoded?.role === 'string' ? decoded.role : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Required Supabase credentials
// ---------------------------------------------------------------------------

const supabaseUrl = resolve('supabaseUrl', {
  canonical: 'SUPABASE_URL',
  aliases: ['SUPABASE_PROJECT_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_API_URL'],
  fallback: 'http://localhost:54321',
  hint: 'Supabase Dashboard → Project Settings → API → "Project URL".',
  example: 'https://abcdefghijklmnopqrst.supabase.co',
});

const supabaseAnonKey = resolve('supabaseAnonKey', {
  canonical: 'SUPABASE_ANON_KEY',
  aliases: ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_PUBLIC_KEY', 'SUPABASE_KEY'],
  fallback: 'anon-placeholder',
  hint: 'Supabase Dashboard → Project Settings → API → "anon public" / "publishable" key.',
});

const supabaseServiceRoleKey = resolve('supabaseServiceRoleKey', {
  canonical: 'SUPABASE_SERVICE_ROLE_KEY',
  aliases: ['SUPABASE_SERVICE_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE'],
  fallback: 'service-placeholder',
  hint: 'Supabase Dashboard → Project Settings → API → "service_role" / "secret" key (SERVER ONLY).',
});

// Value-level checks are skipped when validation is disabled (local tooling
// runs with the placeholder fallbacks above).
const checkValues = !validationSkipped;

if (supabaseUrl && checkValues) {
  if (PLACEHOLDER_RE.test(supabaseUrl) || /^https?:\/\/your-project/i.test(supabaseUrl)) {
    problems.push({
      title: 'SUPABASE_URL is still the placeholder from .env.example',
      detail: `Current value: ${mask(supabaseUrl)}\n     Paste your real project URL from Supabase → Project Settings → API.`,
    });
  } else if (!/^https?:\/\//i.test(supabaseUrl)) {
    problems.push({
      title: 'SUPABASE_URL must be a full URL',
      detail: `Current value: ${mask(supabaseUrl)}\n     It must start with https:// — e.g. https://abcdefghijklmnopqrst.supabase.co`,
    });
  } else {
    try {
      const parsed = new URL(supabaseUrl);
      if (parsed.pathname !== '/' && parsed.pathname !== '') {
        warnings.push(
          `SUPABASE_URL has a path (${parsed.pathname}). It should be the bare project URL (https://<ref>.supabase.co).`
        );
      }
      if (isProduction && /localhost|127\.0\.0\.1/.test(parsed.hostname)) {
        problems.push({
          title: 'SUPABASE_URL points at localhost in production',
          detail: `Current value: ${mask(supabaseUrl)}\n     Railway cannot reach your machine — use the public Supabase project URL.`,
        });
      }
      if (isProduction && parsed.protocol !== 'https:') {
        warnings.push('SUPABASE_URL uses http:// in production — use https://.');
      }
    } catch {
      problems.push({
        title: 'SUPABASE_URL is not a valid URL',
        detail: `Current value: ${mask(supabaseUrl)}`,
      });
    }
  }
}

for (const [name, value] of checkValues
  ? [
      ['SUPABASE_ANON_KEY', supabaseAnonKey],
      ['SUPABASE_SERVICE_ROLE_KEY', supabaseServiceRoleKey],
    ]
  : []) {
  if (value && PLACEHOLDER_RE.test(value)) {
    problems.push({
      title: `${name} is still the placeholder from .env.example`,
      detail: `Current value: ${mask(value)}\n     Copy the real key from Supabase → Project Settings → API.`,
    });
  }
}

// Footgun: the anon key pasted into the service-role slot. The app boots, then
// every admin/payment/storage call fails with an opaque RLS/permission error.
if (supabaseServiceRoleKey && checkValues && !PLACEHOLDER_RE.test(supabaseServiceRoleKey)) {
  const role = jwtRole(supabaseServiceRoleKey);
  if (role === 'anon') {
    problems.push({
      title: 'SUPABASE_SERVICE_ROLE_KEY contains the ANON key',
      detail:
        'The JWT role claim is "anon", so every privileged call (admin actions, storage uploads, signed URLs) will be rejected by RLS.\n     Copy the service_role / secret key from Supabase → Project Settings → API.',
    });
  } else if (role && role !== 'service_role') {
    warnings.push(`SUPABASE_SERVICE_ROLE_KEY has an unexpected JWT role "${role}" (expected "service_role").`);
  }
}

if (supabaseAnonKey && checkValues && !PLACEHOLDER_RE.test(supabaseAnonKey)) {
  const role = jwtRole(supabaseAnonKey);
  if (role === 'service_role') {
    problems.push({
      title: 'SUPABASE_ANON_KEY contains the SERVICE ROLE key',
      detail:
        'That key bypasses RLS and must never be used as the public key. Put the anon/publishable key in SUPABASE_ANON_KEY and keep the service-role key server-side.',
    });
  }
}

// ---------------------------------------------------------------------------
// Optional settings
// ---------------------------------------------------------------------------

function optional(name, fallback = '', key = name.toLowerCase()) {
  const found = read([name]);
  if (found) resolved.push({ key, variable: name, value: found.value });
  return found ? found.value : fallback;
}

const frontendUrlsRaw = optional('FRONTEND_URL', 'http://localhost:5173', 'frontendurls');
if (isProduction && frontendUrlsRaw && /localhost|127\.0\.0\.1/.test(frontendUrlsRaw)) {
  warnings.push(
    'FRONTEND_URL still points at localhost in production — browsers from your real frontend will be blocked by CORS. Set it to your deployed frontend origin(s), comma separated.'
  );
}

const databaseUrl = optional('DATABASE_URL');
if (isProduction && databaseUrl && /localhost|127\.0\.0\.1/.test(databaseUrl)) {
  warnings.push('DATABASE_URL points at localhost — it is only used by `npm run migrate`, run that locally.');
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (skipRequested && isProduction) {
  warnings.push('SKIP_ENV_VALIDATION=true is ignored when NODE_ENV=production.');
}

if (validationSkipped) {
  warnings.push(
    'Environment validation is SKIPPED (SKIP_ENV_VALIDATION=true). Placeholder credentials are in use — anything that talks to Supabase will fail.'
  );
}

function box(title) {
  const width = 74;
  const line = '═'.repeat(width - 2);
  return ['', `╔${line}╗`, `║ ${title.padEnd(width - 4)} ║`, `╚${line}╝`, ''].join('\n');
}

if (warnings.length > 0) {
  console.warn(box('WOLI DAN TECH HUB — configuration warnings'));
  for (const warning of warnings) console.warn(`  ⚠ ${warning}\n`);
}

if (problems.length > 0) {
  console.error(box('WOLI DAN TECH HUB — backend cannot start: bad configuration'));
  console.error(`  ${problems.length} environment variable problem(s) found:\n`);
  problems.forEach((problem, index) => {
    console.error(`  ${index + 1}) ${problem.title}`);
    console.error(`     ${problem.detail}\n`);
  });
  console.error('  Fix them in Railway: open the service → Variables (or Shared Variables) →');
  console.error('  add each variable → Railway redeploys automatically.');
  console.error('  Full reference: .env.example and README.md → "Deploying to Railway".\n');
  // Exit (instead of throwing) so the log shows the report above rather than a
  // raw module-loader stack trace.
  process.exit(1);
}

export const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  isProduction,

  port: Number(optional('PORT', '5000')) || 5000,

  supabaseUrl,
  supabaseAnonKey,
  supabaseServiceRoleKey,

  frontendUrls: frontendUrlsRaw
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean),

  databaseUrl,

  adminEmail: optional('ADMIN_EMAIL', 'wolidantech@gmail.com'),
  adminInitialPassword: optional('ADMIN_INITIAL_PASSWORD'),

  autoConfirmEmail: (optional('AUTO_CONFIRM_EMAIL', 'false') || 'false').toLowerCase() === 'true',

  maxReceiptSizeMb: Number(optional('MAX_RECEIPT_SIZE_MB', '5')) || 5,
  maxResourceSizeMb: Number(optional('MAX_RESOURCE_SIZE_MB', '20')) || 20,
};

// Bucket names used across the application
export const BUCKETS = {
  receipts: 'payment-receipts', // private - signed URLs only
  certificates: 'certificates', // private - signed URLs only
  lessonResources: 'lesson-resources', // private - signed URLs only
  avatars: 'avatars', // public
  courseThumbnails: 'course-thumbnails', // public
};

export const RECEIPT_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

/** Masked snapshot of the resolved configuration — safe to print in logs. */
export function configReport() {
  const byKey = new Map(resolved.map((entry) => [entry.key, entry]));
  const secretKeys = new Set(['supabaseanonkey', 'supabaseservicerolekey', 'admininitialpassword', 'databaseurl']);

  const rows = Object.entries(env).map(([key, value]) => {
    const source = byKey.get(key.toLowerCase());
    const display = Array.isArray(value)
      ? value.join(', ')
      : secretKeys.has(key.toLowerCase())
        ? mask(String(value ?? ''))
        : String(value);
    return { setting: key, variable: source?.variable || '(default)', value: display };
  });

  return rows;
}

export default env;
