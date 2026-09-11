import dotenv from 'dotenv';

dotenv.config();

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
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

  port: Number(optional('PORT', '5000')),

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

// Bucket names used across the application
export const BUCKETS = {
  receipts: 'payment-receipts', // private - signed URLs only
  certificates: 'certificates', // private - signed URLs only
  lessonResources: 'lesson-resources', // private - signed URLs only
  avatars: 'avatars', // public
  courseThumbnails: 'course-thumbnails', // public
};

export const RECEIPT_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

export default env;
