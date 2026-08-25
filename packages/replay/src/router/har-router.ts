import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFile as readFileAsync } from 'node:fs/promises';
import type { BrowserContext, Route } from 'playwright';

type HarHeader = { name: string; value: string };

type HarContent = {
  mimeType?: string;
  text?: string;
  encoding?: string;
  _file?: string;
};

export type HarEntry = {
  startedDateTime?: string;
  request?: {
    method?: string;
    url?: string;
    headers?: HarHeader[];
    postData?: { text?: string; mimeType?: string };
  };
  response?: {
    status?: number;
    statusText?: string;
    headers?: HarHeader[];
    content?: HarContent;
    redirectURL?: string;
  };
};

type HarFile = {
  log?: {
    entries?: HarEntry[];
  };
};

export type HarRouteTable = {
  entries: HarEntry[];
  harDir?: string;
};

const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  ':status',
  'content-security-policy',
  'content-security-policy-report-only',
  'permissions-policy',
]);

export async function loadHarRouteTable(path: string): Promise<HarRouteTable> {
  const raw = JSON.parse(await readFileAsync(path, 'utf8')) as HarFile;
  const entries = raw.log?.entries ?? [];
  if (entries.length === 0) {
    throw new Error('HAR has no entries to replay');
  }
  return { entries };
}

function normalizeUrl(url: string, stripSearch = false): string {
  try {
    const u = new URL(url);
    u.hash = '';
    if (stripSearch) u.search = '';
    let href = u.href;
    if (stripSearch && href.endsWith('/')) href = href.slice(0, -1);
    return href;
  } catch {
    return url;
  }
}

function entryHasBody(entry: HarEntry): boolean {
  const c = entry.response?.content;
  return Boolean(c?.text != null || c?._file);
}

function entryIndex(table: HarRouteTable, entry: HarEntry): number {
  return table.entries.indexOf(entry);
}

function scoreEntry(entry: HarEntry, index: number): number {
  let score = index;
  if (entryHasBody(entry)) score += 10_000;
  return score;
}

function pickBest(candidates: HarEntry[], table: HarRouteTable): HarEntry | undefined {
  if (candidates.length === 0) return undefined;
  let best = candidates[0]!;
  let bestScore = scoreEntry(best, entryIndex(table, best));
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i]!;
    const s = scoreEntry(c, entryIndex(table, c));
    if (s >= bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}

function postDataMatches(entry: HarEntry, postData?: string | null): boolean {
  if (!postData) return true;
  const recorded = entry.request?.postData?.text;
  if (recorded == null) return true;
  return recorded === postData;
}

/**
 * Find the best HAR entry for an outgoing request.
 * Exported for unit tests.
 */
export function findHarEntry(
  table: HarRouteTable,
  method: string,
  url: string,
  postData?: string | null,
): HarEntry | undefined {
  const m = method.toUpperCase();
  const target = normalizeUrl(url);

  const exact = table.entries.filter(
    (e) =>
      (e.request?.method ?? 'GET').toUpperCase() === m &&
      normalizeUrl(e.request?.url ?? '') === target &&
      postDataMatches(e, postData),
  );
  if (exact.length > 0) return pickBest(exact, table);

  const slash = table.entries.filter((e) => {
    if ((e.request?.method ?? 'GET').toUpperCase() !== m) return false;
    if (!postDataMatches(e, postData)) return false;
    const a = normalizeUrl(e.request?.url ?? '').replace(/\/$/, '');
    const b = target.replace(/\/$/, '');
    return a === b;
  });
  if (slash.length > 0) return pickBest(slash, table);

  // GET: match same origin + pathname when query params drift (tokens, cache bust)
  if (m === 'GET') {
    let origin = '';
    let pathname = '';
    try {
      const u = new URL(url);
      origin = u.origin;
      pathname = u.pathname;
    } catch {
      return undefined;
    }

    const pathMatches = table.entries.filter((e) => {
      if ((e.request?.method ?? 'GET').toUpperCase() !== 'GET') return false;
      try {
        const u = new URL(e.request?.url ?? '');
        return u.origin === origin && u.pathname === pathname;
      } catch {
        return false;
      }
    });

    if (pathMatches.length > 0) {
      return pickBest(pathMatches, table);
    }
  }

  return undefined;
}

export function resolveHarBody(
  content: HarContent | undefined,
  harDir?: string,
): Buffer | string | undefined {
  if (!content) return undefined;
  return bodyFromContent(content, harDir);
}

export function bodyFromHarEntry(
  entry: HarEntry,
  harDir?: string,
): Buffer | string | undefined {
  return resolveHarBody(entry.response?.content, harDir);
}

function bodyFromContent(
  content: HarContent,
  harDir?: string,
): Buffer | string | undefined {
  if (content.text != null) {
    if ((content.encoding ?? '').toLowerCase() === 'base64') {
      return Buffer.from(content.text, 'base64');
    }
    return content.text;
  }
  if (content._file && harDir) {
    try {
      // Playwright stores paths relative to the HAR file directory
      return readFileSync(join(harDir, content._file));
    } catch {
      try {
        // Fallback: basename only (some archives nest oddly)
        return readFileSync(join(harDir, content._file.split(/[/\\]/).pop()!));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function headersToObject(
  headers: HarHeader[] | undefined,
  mimeType?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    const name = h.name.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(name)) continue;
    out[h.name] = h.value;
  }
  if (
    mimeType &&
    !Object.keys(out).some((k) => k.toLowerCase() === 'content-type')
  ) {
    out['Content-Type'] = mimeType;
  }
  return out;
}

export async function attachHarRouter(
  context: BrowserContext,
  table: HarRouteTable,
  onMiss?: (url: string, method: string) => void,
): Promise<void> {
  await context.route('**/*', async (route: Route) => {
    const req = route.request();
    const method = req.method();
    const url = req.url();

    if (
      url.startsWith('data:') ||
      url.startsWith('blob:') ||
      url.startsWith('about:')
    ) {
      await route.continue();
      return;
    }

    const entry = findHarEntry(table, method, url, req.postData() ?? null);
    if (!entry?.response) {
      onMiss?.(url, method);
      await route.abort();
      return;
    }

    const status = entry.response.status ?? 200;
    const redirectURL = entry.response.redirectURL?.trim();
    if (status >= 300 && status < 400 && redirectURL) {
      const headers = headersToObject(entry.response.headers);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'location')) {
        headers.Location = redirectURL;
      }
      await route.fulfill({ status, headers, body: '' });
      return;
    }

    const content = entry.response.content ?? {};
    const body = bodyFromContent(content, table.harDir);
    const headers = headersToObject(entry.response.headers, content.mimeType);

    try {
      await route.fulfill({
        status,
        headers,
        body: body ?? '',
        contentType: content.mimeType,
      });
    } catch {
      onMiss?.(url, method);
      await route.abort();
    }
  });
}
