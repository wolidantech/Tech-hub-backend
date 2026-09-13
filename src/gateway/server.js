/**
 * Composition root for the WOLI DAN TECH HUB Secure AI Gateway.
 * Railway runs this file (`npm start`).
 */
import { config, PLATFORM, DANTECH_NAME } from './config.js';
import { createProvider } from './providers/index.js';
import { createSupabase } from './supabase.js';
import { createAuth } from './auth.js';
import { createApp } from './app.js';

/** Minimal structured logger. Bodies, tokens and keys are never logged. */
const logger = {
  info: (entry) => console.log(JSON.stringify({ level: 'info', ...entry })),
  warn: (entry) => console.warn(JSON.stringify({ level: 'warn', ...entry })),
  error: (entry) => console.error(JSON.stringify({ level: 'error', ...entry })),
};

const provider = createProvider(config);
const supabase = createSupabase({ url: config.supabaseUrl, serviceKey: config.supabaseServiceRoleKey });
const auth = createAuth({
  supabaseUrl: config.supabaseUrl,
  serviceKey: config.supabaseServiceRoleKey,
  supabase,
});

const app = createApp({ config, provider, supabase, auth, logger });

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log('');
  console.log(`  ${PLATFORM} — SECURE AI GATEWAY`);
  console.log('  ----------------------------------------');
  console.log(`  Listening on  http://0.0.0.0:${config.port}`);
  console.log(`  Environment   ${config.nodeEnv}`);
  console.log(`  AI provider   ${provider.name} / ${provider.model}`);
  console.log(`  Assistant     ${DANTECH_NAME}`);
  console.log(`  Health        http://0.0.0.0:${config.port}/health`);
  console.log(`  CORS origins  ${config.allowedOrigins.join(', ') || '(none)'}`);
  console.log('');
});

process.on('unhandledRejection', (reason) => {
  logger.error({ error: 'unhandledRejection', detail: String(reason).slice(0, 300) });
});
process.on('uncaughtException', (error) => {
  logger.error({ error: 'uncaughtException', detail: String(error?.message).slice(0, 300) });
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    logger.info({ message: `${signal} received — shutting down gracefully` });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

export { app, server };
