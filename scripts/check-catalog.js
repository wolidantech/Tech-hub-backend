#!/usr/bin/env node
// Checks if catalog would appear empty to anon key (what students see)
// Usage: node scripts/check-catalog.js
// Requires SUPABASE_URL and SUPABASE_ANON_KEY in env or .env

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const envPath = join(root, '.env');

if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      let v = m[2].replace(/^['"]|['"]$/g, '');
      process.env[m[1]] = v;
    }
  }
}

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
  console.error('Set them in .env or env vars');
  process.exit(1);
}

console.log(`Checking catalog at ${url} ...`);

async function check() {
  const endpoints = [
    { name: 'courses (published only)', path: '/rest/v1/courses?select=id,title,slug,is_published&is_published=eq.true&limit=20' },
    { name: 'courses (all, anon view)', path: '/rest/v1/courses?select=id,title,is_published&limit=20' },
    { name: 'categories', path: '/rest/v1/course_categories?select=id,name&limit=20' },
  ];

  for (const ep of endpoints) {
    try {
      const res = await fetch(`${url}${ep.path}`, {
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
        },
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      const count = Array.isArray(data) ? data.length : 'N/A';
      console.log(`\n[${res.status}] ${ep.name}: ${count} rows`);
      if (Array.isArray(data) && data.length > 0) {
        console.log(`  Sample: ${data.slice(0,3).map(c => c.title || c.name).join(', ')}`);
      } else if (Array.isArray(data) && data.length === 0) {
        console.log(`  -> EMPTY — this is why students see diagnostics!`);
      } else {
        console.log(`  Response: ${JSON.stringify(data).slice(0,500)}`);
      }
    } catch (e) {
      console.log(`\n[ERROR] ${ep.name}: ${e.message}`);
    }
  }

  console.log('\n--- Diagnosis ---');
  console.log('If published courses = 0 but all courses >0, run publish_courses.sql');
  console.log('If all courses = 0, run seed_12_courses.sql then publish_courses.sql');
  console.log('See supabase/seed/README.md');
}

check();
