import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import type { Hono } from 'hono';
import { WEB_DIST_DIR } from './paths.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function safeJoin(root: string, reqPath: string): string | null {
  const cleaned = normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = join(root, cleaned);
  if (!full.startsWith(normalize(root))) return null;
  return full;
}

/**
 * Serve the Vite build from WEB_DIST_DIR on the same origin as /api
 * (production VM / container). No-ops if the dist folder is missing.
 */
export function mountWebStatic(app: Hono): void {
  app.get('*', async (c) => {
    const urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    if (urlPath.startsWith('/api')) {
      return c.json({ error: 'Not found' }, 404);
    }

    let filePath = safeJoin(
      WEB_DIST_DIR,
      urlPath === '/' ? 'index.html' : urlPath.slice(1),
    );
    if (!filePath) return c.json({ error: 'Invalid path' }, 400);

    try {
      const st = await stat(filePath);
      if (st.isDirectory()) {
        filePath = join(filePath, 'index.html');
      }
      const data = await readFile(filePath);
      const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      return new Response(data, {
        headers: {
          'Content-Type': type,
          'Cache-Control':
            extname(filePath) === '.html'
              ? 'no-cache'
              : 'public, max-age=86400',
        },
      });
    } catch {
      // SPA fallback
      try {
        const index = await readFile(join(WEB_DIST_DIR, 'index.html'));
        return new Response(index, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
          },
        });
      } catch {
        return c.text(
          'Web UI not built. Run `pnpm --filter @snapshot/web build` or set SNAPSHOT_WEB_DIST.',
          503,
        );
      }
    }
  });
}
