import app from './app.js';
import { env } from './config/env.js';

const server = app.listen(env.port, '0.0.0.0', () => {
  console.log('');
  console.log('  WOLI DAN TECH HUB — LEARN • BUILD • GROW');
  console.log('  ----------------------------------------');
  console.log(`  API listening on http://0.0.0.0:${env.port}`);
  console.log(`  Environment: ${env.nodeEnv}`);
  console.log(`  Health:      http://0.0.0.0:${env.port}/health`);
  console.log('');
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandled-rejection]', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[uncaught-exception]', error);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal} received — shutting down gracefully`);
    server.close(() => process.exit(0));
  });
}
