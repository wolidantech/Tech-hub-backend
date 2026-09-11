/**
 * Creates (or promotes) the initial ADMINISTRATOR account.
 *
 * The password is provided securely via the ADMIN_INITIAL_PASSWORD
 * environment variable (never hard-coded, never committed).
 *
 * Usage:
 *   ADMIN_INITIAL_PASSWORD='a-strong-password' npm run create:admin
 *
 * Or set ADMIN_INITIAL_PASSWORD in .env and simply run:
 *   npm run create:admin
 */
import readline from 'node:readline/promises';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'wolidantech@gmail.com').trim().toLowerCase();
let ADMIN_PASSWORD = process.env.ADMIN_INITIAL_PASSWORD;

async function promptPassword() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pwd = await rl.question('Enter initial admin password (min 8 chars, letters + digits): ');
  rl.close();
  return pwd.trim();
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
    process.exit(1);
  }

  if (!ADMIN_PASSWORD) {
    if (!process.stdin.isTTY) {
      console.error('ERROR: ADMIN_INITIAL_PASSWORD is not set and no interactive terminal is available.');
      process.exit(1);
    }
    ADMIN_PASSWORD = await promptPassword();
  }

  if (ADMIN_PASSWORD.length < 8 || !/[a-zA-Z]/.test(ADMIN_PASSWORD) || !/[0-9]/.test(ADMIN_PASSWORD)) {
    console.error('ERROR: password must be at least 8 characters and contain letters and numbers.');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Try to create the user; if the email already exists, promote that user.
  let userId;
  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: 'Woli Dan (Admin)' },
    app_metadata: { role: 'admin' },
  });

  if (createError) {
    if (/already (been )?registered/i.test(createError.message)) {
      console.log(`Account ${ADMIN_EMAIL} already exists — promoting to admin and resetting password...`);
      const { data: list } = await supabase.auth.admin.listUsers();
      const existing = list?.users?.find((u) => u.email?.toLowerCase() === ADMIN_EMAIL);
      if (!existing) {
        console.error('Could not locate the existing user.');
        process.exit(1);
      }
      userId = existing.id;
      const { error: updErr } = await supabase.auth.admin.updateUserById(userId, {
        password: ADMIN_PASSWORD,
        email_confirm: true,
        app_metadata: { role: 'admin' },
      });
      if (updErr) {
        console.error('Failed to update existing user:', updErr.message);
        process.exit(1);
      }
    } else {
      console.error('Failed to create admin user:', createError.message);
      process.exit(1);
    }
  } else {
    userId = created.user.id;
  }

  // Upsert the profile row with role = admin
  const { error: profileError } = await supabase.from('profiles').upsert(
    {
      user_id: userId,
      full_name: 'Woli Dan (Admin)',
      email: ADMIN_EMAIL,
      role: 'admin',
    },
    { onConflict: 'user_id' }
  );

  if (profileError) {
    console.error('Failed to upsert admin profile:', profileError.message);
    process.exit(1);
  }

  console.log('');
  console.log('  ✔ Admin account is ready');
  console.log(`    Email:  ${ADMIN_EMAIL}`);
  console.log('    Password: (set from ADMIN_INITIAL_PASSWORD — stored only in Supabase Auth)');
  console.log('');
  console.log('  Log in via POST /api/auth/login and use the /api/admin/* endpoints.');
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
