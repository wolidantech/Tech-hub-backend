/**
 * (Re)creates the Supabase Storage buckets with the right privacy,
 * size limits and MIME allowlists.
 *
 * Migration 004 already does this via SQL — run this script only if
 * you applied the schema with the Supabase CLI and want to be sure,
 * or after recreating a project.
 *
 * Usage:  npm run storage:setup
 */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const REQUIRED = [
  {
    id: 'payment-receipts',
    public: false,
    fileSizeLimit: 5 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'application/pdf'],
  },
  {
    id: 'certificates',
    public: false,
    fileSizeLimit: 5 * 1024 * 1024,
    allowedMimeTypes: ['application/pdf'],
  },
  {
    id: 'lesson-resources',
    public: false,
    fileSizeLimit: 20 * 1024 * 1024,
    allowedMimeTypes: [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'application/zip',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
  },
  {
    id: 'avatars',
    public: true,
    fileSizeLimit: 2 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },
  {
    id: 'course-thumbnails',
    public: true,
    fileSizeLimit: 5 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },
];

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
    process.exit(1);
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  for (const bucket of REQUIRED) {
    const { error: createError } = await supabase.storage.createBucket(bucket.id, {
      public: bucket.public,
      fileSizeLimit: bucket.fileSizeLimit,
      allowedMimeTypes: bucket.allowedMimeTypes,
    });

    if (createError && !/already exists/i.test(createError.message)) {
      console.error(`  ✗ ${bucket.id}: ${createError.message}`);
      continue;
    }

    if (createError) {
      // Bucket exists — update its settings instead
      const { error: updateError } = await supabase.storage.updateBucket(bucket.id, {
        public: bucket.public,
        fileSizeLimit: bucket.fileSizeLimit,
        allowedMimeTypes: bucket.allowedMimeTypes,
      });
      if (updateError) {
        console.error(`  ✗ ${bucket.id}: ${updateError.message}`);
        continue;
      }
    }

    console.log(`  ✓ ${bucket.id} (${bucket.public ? 'public' : 'private'})`);
  }

  console.log('\nStorage buckets are ready.');
  console.log('Note: object-level policies live in supabase/migrations/20260910000004_storage.sql');
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
