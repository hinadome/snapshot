export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function isSameOriginUrl(a: string, b: string): boolean {
  const oa = originOf(a);
  const ob = originOf(b);
  return Boolean(oa && ob && oa === ob);
}

export function headerLookup(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export type CorsRequestHints = {
  requestUrl: string;
  pageUrl: string;
  method: string;
  resourceType: string;
  originHeader?: string | null;
  secFetchMode?: string | null;
};

/**
 * Whether a cross-origin response must pass CORS checks before the browser
 * exposes it to the page (fetch/XHR, credentialed loads, crossorigin assets).
 */
export function crossOriginRequestNeedsCors(hints: CorsRequestHints): boolean {
  const {
    requestUrl,
    pageUrl,
    method,
    resourceType,
    originHeader,
    secFetchMode,
  } = hints;

  if (method.toUpperCase() === 'OPTIONS') return true;
  if (isSameOriginUrl(requestUrl, pageUrl)) return false;
  if (resourceType === 'document' || resourceType === 'websocket') return false;

  const mode = (secFetchMode ?? '').toLowerCase();
  if (mode === 'cors') return true;

  if (resourceType === 'fetch' || resourceType === 'xhr' || resourceType === 'eventsource') {
    return true;
  }

  // crossorigin scripts/styles/images/fonts send Origin and require ACAO
  if (originHeader) {
    if (
      resourceType === 'script' ||
      resourceType === 'stylesheet' ||
      resourceType === 'image' ||
      resourceType === 'font' ||
      resourceType === 'manifest'
    ) {
      return true;
    }
  }

  return false;
}

export function corsResponseAllowed(
  origin: string | undefined | null,
  method: string,
  responseHeaders: Record<string, string>,
  withCredentials = false,
): boolean {
  if (!origin?.trim()) return true;

  const acao = headerLookup(responseHeaders, 'access-control-allow-origin');
  if (!acao) return false;

  const allowed = acao.trim();
  if (allowed === '*') {
    return !withCredentials;
  }

  if (allowed !== origin) return false;

  if (withCredentials) {
    const acac = headerLookup(responseHeaders, 'access-control-allow-credentials');
    if (acac?.toLowerCase() !== 'true') return false;
  }

  if (method.toUpperCase() === 'OPTIONS') {
    const acam = headerLookup(responseHeaders, 'access-control-allow-methods');
    if (!acam?.trim()) return false;
  }

  return true;
}

/** HAR entries Chrome records for failed/blocked network requests. */
export function harEntryBlockedInCapture(entry: {
  response?: { status?: number };
  _failureText?: string;
}): boolean {
  const status = entry.response?.status ?? 0;
  if (status === 0) return true;
  const failure = entry._failureText?.toLowerCase() ?? '';
  if (
    failure.includes('cors') ||
    failure.includes('blocked') ||
    failure.includes('err_failed') ||
    failure.includes('err_connection')
  ) {
    return true;
  }
  return false;
}
