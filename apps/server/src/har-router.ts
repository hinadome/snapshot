import { readFile } from 'node:fs/promises';
import type { BrowserContext, Route } from 'playwright';

type HarHeader = { name: string; value: string };

type HarEntry = {
  request?: {
    method?: string;
    url?: string;
    headers?: HarHeader[];
  };
  response?: {
    status?: number;
    statusText?: string;
    headers?: HarHeader[];
    content?: {
      mimeType?: string;
      text?: string;
      encoding?: string;
    };
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
};

export async function loadHarRouteTable(path: string): Promise<HarRouteTable> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as HarFile;
  const entries = raw.log?.entries ?? [];
  if (entries.length === 0) {
    throw new Error('HAR has no entries to replay');
  }
  return { entries };
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Drop hash; keep query (strict match helps POST APIs)
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}

function findEntry(
  table: HarRouteTable,
  method: string,
  url: string,
): HarEntry | undefined {
  const m = method.toUpperCase();
  const target = normalizeUrl(url);
  const candidates = table.entries.filter(
    (e) =>
      (e.request?.method ?? 'GET').toUpperCase() === m &&
      normalizeUrl(e.request?.url ?? '') === target,
  );
  if (candidates.length === 0) {
    // Soft match: ignore trailing slash differences
    const soft = table.entries.filter((e) => {
      if ((e.request?.method ?? 'GET').toUpperCase() !== m) return false;
      const a = normalizeUrl(e.request?.url ?? '').replace(/\/$/, '');
      const b = target.replace(/\/$/, '');
      return a === b;
    });
    return soft[0];
  }
  // Prefer entry that has a response body
  return (
    candidates.find((e) => e.response?.content?.text != null) ?? candidates[0]
  );
}

function bodyFromContent(content: {
  text?: string;
  encoding?: string;
}): Buffer | string | undefined {
  if (content.text == null) return undefined;
  if ((content.encoding ?? '').toLowerCase() === 'base64') {
    return Buffer.from(content.text, 'base64');
  }
  return content.text;
}

function headersToObject(
  headers: HarHeader[] | undefined,
  mimeType?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    const name = h.name.toLowerCase();
    // Hop-by-hop / framing headers that break fulfill
    if (
      name === 'content-encoding' ||
      name === 'content-length' ||
      name === 'transfer-encoding' ||
      name === 'connection' ||
      name === ':status'
    ) {
      continue;
    }
    out[h.name] = h.value;
  }
  if (mimeType && !Object.keys(out).some((k) => k.toLowerCase() === 'content-type')) {
    out['Content-Type'] = mimeType;
  }
  return out;
}

/**
 * Attach a request handler that fulfills from HAR entries (Chrome DevTools HARs).
 * More predictable than routeFromHAR for third-party captures.
 */
export async function attachHarRouter(
  context: BrowserContext,
  table: HarRouteTable,
  onMiss?: (url: string, method: string) => void,
): Promise<void> {
  await context.route('**/*', async (route: Route) => {
    const req = route.request();
    const method = req.method();
    const url = req.url();

    // Let data: and about: through (Playwright handles them)
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) {
      await route.continue();
      return;
    }

    const entry = findEntry(table, method, url);
    if (!entry?.response) {
      onMiss?.(url, method);
      await route.abort();
      return;
    }

    const status = entry.response.status ?? 200;
    const content = entry.response.content ?? {};
    const body = bodyFromContent(content);
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
