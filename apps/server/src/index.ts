import { serve } from '@hono/node-server';
import { registerBuiltInStrategies } from '@snapshot/core';
import { closeBrowser } from '@snapshot/replay';
import { app } from './app.js';
import { ensureDataDirs, HOST, PORT, WEB_DIST_DIR } from './paths.js';

registerBuiltInStrategies();

await ensureDataDirs();

console.log(`Snapshot server listening on http://${HOST}:${PORT}`);
console.log(`Web UI dist: ${WEB_DIST_DIR}`);
serve({ fetch: app.fetch, port: PORT, hostname: HOST });

const shutdown = async () => {
  await closeBrowser();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
