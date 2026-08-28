import type { Context, Next } from 'hono';

/** UUID v4 (job ids from uuid v4). Rejects path traversal in :id routes. */
const JOB_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidJobId(id: string): boolean {
  return JOB_ID_RE.test(id);
}

export const API_TOKEN = process.env.SNAPSHOT_API_TOKEN?.trim() || '';
export const SESSION_COOKIE = 'snapshot_token';
const SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;

export function sessionCookieHeader(token: string): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SEC}${secure}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict`;
}

function readClientToken(c: Context): string | undefined {
  const auth = c.req.header('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const header = c.req.header('x-snapshot-token')?.trim();
  if (header) return header;
  const cookie = c.req.header('cookie');
  if (cookie) {
    const match = cookie.match(/(?:^|;\s*)snapshot_token=([^;]+)/);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

/** Exported for auth session status checks. */
export function readClientTokenFromHeaders(c: Context): string | undefined {
  return readClientToken(c);
}

function isAuthExemptPath(path: string): boolean {
  return path === '/api/health' || path.startsWith('/api/auth/');
}

/** Optional auth when SNAPSHOT_API_TOKEN is set. Uses HttpOnly cookie for browser sessions. */
export async function apiAuthMiddleware(
  c: Context,
  next: Next,
): Promise<Response | void> {
  if (!API_TOKEN) return next();
  if (isAuthExemptPath(c.req.path)) return next();

  const token = readClientToken(c);
  if (token !== API_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Establish HttpOnly session cookie when client sends Bearer (not cookie-only refresh)
  if (c.req.header('authorization') || c.req.header('x-snapshot-token')) {
    c.header('Set-Cookie', sessionCookieHeader(token));
  }

  return next();
}

export function clientErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const msg = err.message;
  if (/exceeds.*limit/i.test(msg)) return msg;
  if (/empty|missing|expected|invalid|unsupported|refusing/i.test(msg)) return msg;
  return fallback;
}

export const MAX_LIST_JOBS = 100;
export const MAX_QUEUE_LENGTH = Number(process.env.SNAPSHOT_MAX_QUEUE ?? 8);
