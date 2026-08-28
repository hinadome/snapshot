import type { Hono } from 'hono';
import {
  API_TOKEN,
  clearSessionCookieHeader,
  readClientTokenFromHeaders,
  sessionCookieHeader,
} from './security.js';

/** Auth session routes — mounted before apiAuthMiddleware. */
export function mountAuthRoutes(app: Hono): void {
  app.get('/api/auth/session', (c) => {
    if (!API_TOKEN) {
      return c.json({ required: false, authenticated: true });
    }
    const token = readClientTokenFromHeaders(c);
    return c.json({
      required: true,
      authenticated: token === API_TOKEN,
    });
  });

  app.post('/api/auth/session', async (c) => {
    if (!API_TOKEN) {
      return c.json({ ok: true, required: false });
    }

    let token = '';
    const auth = c.req.header('authorization');
    if (auth?.toLowerCase().startsWith('bearer ')) {
      token = auth.slice(7).trim();
    } else {
      const body = (await c.req.json().catch(() => ({}))) as {
        token?: string;
      };
      token = body.token?.trim() ?? '';
    }

    if (!token || token !== API_TOKEN) {
      return c.json({ error: 'Invalid token' }, 401);
    }

    c.header('Set-Cookie', sessionCookieHeader(token));
    return c.json({ ok: true, required: true });
  });

  app.delete('/api/auth/session', (c) => {
    c.header('Set-Cookie', clearSessionCookieHeader());
    return c.json({ ok: true });
  });
}
