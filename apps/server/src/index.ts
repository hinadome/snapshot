import { serve } from '@hono/node-server';
import { registerBuiltInStrategies } from '@snapshot/core';
import { closeBrowser } from '@snapshot/replay';
import { app } from './app.js';
import { ensureDataDirs, PORT } from './paths.js';

registerBuiltInStrategies();

await ensureDataDirs();

console.log(`Snapshot server listening on http://localhost:${PORT}`);
serve({ fetch: app.fetch, port: PORT });

const shutdown = async () => {
  await closeBrowser();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
