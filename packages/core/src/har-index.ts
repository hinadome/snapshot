import type {
  DocumentNavigation,
  HarEntrySummary,
  HarIndex,
  HarPage,
} from './types.js';

type HarHeader = { name: string; value: string };

type HarContent = {
  size?: number;
  mimeType?: string;
  text?: string;
  encoding?: string;
  _file?: string;
};

type HarResponse = {
  status?: number;
  statusText?: string;
  headers?: HarHeader[];
  content?: HarContent;
  redirectURL?: string;
};

type HarRequest = {
  method?: string;
  url?: string;
  headers?: HarHeader[];
};

type HarEntry = {
  pageref?: string;
  startedDateTime?: string;
  time?: number;
  request?: HarRequest;
  response?: HarResponse;
  _resourceType?: string;
};

type HarPageRaw = {
  id?: string;
  title?: string;
  startedDateTime?: string;
  pageTimings?: Record<string, number>;
};

type HarLog = {
  version?: string;
  creator?: { name?: string; version?: string };
  pages?: HarPageRaw[];
  entries?: HarEntry[];
};

export type HarFile = {
  log: HarLog;
};

function parseTimeMs(iso?: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function isHtmlMime(mimeType: string): boolean {
  const lower = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  return lower === 'text/html' || lower === 'application/xhtml+xml';
}

function isMainFrameDocument(entry: HarEntry): boolean {
  const resourceType = (entry._resourceType ?? '').toLowerCase();
  return resourceType === 'document' || resourceType === 'mainframe';
}

function looksLikeHtmlNavigation(entry: HarEntry, mimeType: string): boolean {
  if (!isHtmlMime(mimeType)) return false;
  const method = (entry.request?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') return false;

  const accept = (entry.request?.headers ?? [])
    .find((h) => h.name.toLowerCase() === 'accept')
    ?.value?.toLowerCase() ?? '';

  if (accept.includes('text/html')) return true;
  if (!accept || accept.includes('*/*')) return true;
  return false;
}

function buildMainDocuments(
  entriesRaw: HarEntry[],
  sessionStartMs: number,
  pageMap: Map<string, HarPage>,
): DocumentNavigation[] {
  const byPageref = new Map<string, HarEntry[]>();

  entriesRaw.forEach((entry) => {
    const url = entry.request?.url ?? '';
    const status = entry.response?.status ?? 0;
    const mimeType = entry.response?.content?.mimeType ?? '';
    if (!url || status < 200 || status >= 400) return;

    const pageref = entry.pageref ?? 'page_0';
    const isMainDoc = isMainFrameDocument(entry);
    const isHtmlNav = looksLikeHtmlNavigation(entry, mimeType);

    if (!isMainDoc && !isHtmlNav) return;

    if (!byPageref.has(pageref)) byPageref.set(pageref, []);
    byPageref.get(pageref)!.push(entry);
  });

  const docs: DocumentNavigation[] = [];

  for (const [pageref, group] of byPageref) {
    group.sort(
      (a, b) =>
        (parseTimeMs(a.startedDateTime) ?? sessionStartMs) -
        (parseTimeMs(b.startedDateTime) ?? sessionStartMs),
    );

    const main =
      group.find((e) => isMainFrameDocument(e)) ??
      group.find((e) =>
        looksLikeHtmlNavigation(
          e,
          e.response?.content?.mimeType ?? '',
        ),
      ) ??
      group[0];

    if (!main) continue;

    const url = main.request?.url ?? '';
    const startedDateTime = main.startedDateTime ?? '';
    const startedAbs = parseTimeMs(startedDateTime) ?? sessionStartMs;
    const entryIndex = entriesRaw.indexOf(main);

    docs.push({
      entryIndex: entryIndex >= 0 ? entryIndex : 0,
      pageref,
      url,
      startedDateTime,
      startedMs: startedAbs - sessionStartMs,
      title: pageTitle(pageMap, pageref, url),
      mimeType: main.response?.content?.mimeType ?? '',
      status: main.response?.status ?? 200,
      hasBody: hasResponseBody(main.response?.content),
    });
  }

  return docs.sort((a, b) => a.startedMs - b.startedMs);
}

function hasResponseBody(content?: HarContent): boolean {
  if (!content) return false;
  if (typeof content.text === 'string' && content.text.length > 0) return true;
  if (content._file) return true;
  return false;
}

function detectHarSource(creatorName: string): NonNullable<HarIndex['sourceInfo']> {
  const lower = creatorName.toLowerCase();
  let source = 'har';
  if (lower.includes('webinspector') || lower.includes('chrome')) {
    source = 'devtools-chrome';
  } else if (lower.includes('firefox')) {
    source = 'devtools-firefox';
  } else if (lower.includes('playwright')) {
    source = 'playwright';
  } else if (creatorName) {
    source = `har:${creatorName}`;
  }
  return {
    source,
    creatorName: creatorName || null,
    entryCount: 0,
    pageCount: 0,
    withBody: 0,
    bodyCoveragePct: 0,
    hasDocument: false,
  };
}

function pageTitle(
  pages: Map<string, HarPage>,
  pageref: string | undefined,
  url: string,
): string {
  if (pageref && pages.has(pageref)) {
    const title = pages.get(pageref)!.title;
    if (title && title.trim()) return title.trim();
  }
  try {
    const u = new URL(url);
    return u.pathname === '/' ? u.hostname : `${u.hostname}${u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Parse and index a HAR object. Does not require response bodies to index,
 * but records coverage warnings when bodies are missing.
 */
export function buildHarIndex(raw: unknown): HarIndex {
  const warnings: string[] = [];

  if (!raw || typeof raw !== 'object' || !('log' in raw)) {
    throw new Error('Invalid HAR: missing top-level "log" object');
  }

  const har = raw as HarFile;
  const log = har.log;
  const entriesRaw = Array.isArray(log.entries) ? log.entries : [];
  if (entriesRaw.length === 0) {
    throw new Error('Invalid HAR: log.entries is empty');
  }

  const version = log.version ?? '1.2';
  const creator = log.creator?.name
    ? `${log.creator.name}${log.creator.version ? ` ${log.creator.version}` : ''}`
    : undefined;

  const pageTimes: number[] = [];
  const pages: HarPage[] = (log.pages ?? [])
    .map((p, i) => {
      const startedDateTime = p.startedDateTime ?? '';
      const startedMs = parseTimeMs(startedDateTime) ?? 0;
      if (startedMs) pageTimes.push(startedMs);
      return {
        id: p.id ?? `page_${i}`,
        title: p.title ?? '',
        startedDateTime,
        startedMs,
      };
    })
    .sort((a, b) => a.startedMs - b.startedMs);

  const pageMap = new Map(pages.map((p) => [p.id, p]));

  const entryTimes: number[] = [];
  for (const e of entriesRaw) {
    const t = parseTimeMs(e.startedDateTime);
    if (t != null) entryTimes.push(t);
  }

  const sessionStartMs = Math.min(
    ...[...pageTimes, ...entryTimes].filter((t) => Number.isFinite(t)),
  );
  if (!Number.isFinite(sessionStartMs)) {
    throw new Error('Invalid HAR: no valid startedDateTime values');
  }

  // Re-normalize page startedMs relative if needed (already absolute epoch)
  for (const p of pages) {
    if (!p.startedMs && p.startedDateTime) {
      p.startedMs = parseTimeMs(p.startedDateTime) ?? sessionStartMs;
    }
  }

  const entries: HarEntrySummary[] = [];
  let withBodyCount = 0;

  entriesRaw.forEach((entry, index) => {
    const url = entry.request?.url ?? '';
    const method = (entry.request?.method ?? 'GET').toUpperCase();
    const status = entry.response?.status ?? 0;
    const mimeType = entry.response?.content?.mimeType ?? '';
    const startedDateTime = entry.startedDateTime ?? '';
    const startedAbs = parseTimeMs(startedDateTime) ?? sessionStartMs;
    const startedMs = startedAbs - sessionStartMs;
    const body = hasResponseBody(entry.response?.content);
    if (body) withBodyCount += 1;

    const isDocument =
      Boolean(url) &&
      (isMainFrameDocument(entry) ||
        looksLikeHtmlNavigation(entry, mimeType));

    entries.push({
      index,
      pageref: entry.pageref,
      startedDateTime,
      startedMs,
      method,
      url,
      status,
      mimeType,
      hasBody: body,
      isDocument,
    });
  });

  let finalDocs = buildMainDocuments(entriesRaw, sessionStartMs, pageMap);

  // Deduplicate: same URL + pageref within 500ms → keep first
  const deduped: DocumentNavigation[] = [];
  for (const doc of finalDocs) {
    const prev = deduped[deduped.length - 1];
    if (
      prev &&
      prev.url === doc.url &&
      prev.pageref === doc.pageref &&
      Math.abs(prev.startedMs - doc.startedMs) < 500
    ) {
      continue;
    }
    deduped.push(doc);
  }
  finalDocs = deduped;
  if (finalDocs.length === 0 && pages.length > 0) {
    warnings.push(
      'No document navigations detected from entries; falling back to HAR pages list.',
    );
    finalDocs = pages.map((p, i) => {
      const match = entries.find(
        (e) => e.pageref === p.id && isHtmlMime(e.mimeType),
      );
      return {
        entryIndex: match?.index ?? i,
        pageref: p.id,
        url: match?.url ?? '',
        startedDateTime: p.startedDateTime,
        startedMs: p.startedMs - sessionStartMs,
        title: p.title || p.id,
        mimeType: match?.mimeType ?? 'text/html',
        status: match?.status ?? 200,
        hasBody: match?.hasBody ?? false,
      };
    }).filter((d) => d.url);
  }

  if (finalDocs.length === 0) {
    // Last resort: every HTML response
    finalDocs = entries
      .filter((e) => isHtmlMime(e.mimeType) && e.status >= 200 && e.status < 400)
      .map((e) => ({
        entryIndex: e.index,
        pageref: e.pageref,
        url: e.url,
        startedDateTime: e.startedDateTime,
        startedMs: e.startedMs,
        title: pageTitle(pageMap, e.pageref, e.url),
        mimeType: e.mimeType,
        status: e.status,
        hasBody: e.hasBody,
      }));
    if (finalDocs.length > 0) {
      warnings.push(
        'Using all HTML responses as navigations (no clear document markers).',
      );
    }
  }

  const entryCount = entries.length;
  const bodyCoveragePct =
    entryCount === 0 ? 0 : Math.round((withBodyCount / entryCount) * 1000) / 10;

  if (bodyCoveragePct < 50) {
    warnings.push(
      `Low response-body coverage (${bodyCoveragePct}%). Export “HAR with content” from DevTools for better reconstruction.`,
    );
  }

  const missingDocBodies = finalDocs.filter((d) => !d.hasBody).length;
  if (missingDocBodies > 0) {
    warnings.push(
      `${missingDocBodies} document navigation(s) are missing response bodies and may fail to reconstruct.`,
    );
  }

  if (finalDocs.length === 0) {
    warnings.push('No page navigations found in this HAR.');
  }

  const sourceInfo = detectHarSource(log.creator?.name ?? '');
  sourceInfo.entryCount = entryCount;
  sourceInfo.pageCount = pages.length;
  sourceInfo.withBody = withBodyCount;
  sourceInfo.bodyCoveragePct = bodyCoveragePct;
  sourceInfo.hasDocument = finalDocs.length > 0;

  return {
    version,
    creator,
    sourceInfo,
    sessionStartMs,
    pages: pages.map((p) => ({
      ...p,
      startedMs: p.startedMs - sessionStartMs,
    })),
    entries,
    documents: finalDocs,
    stats: {
      entryCount,
      pageCount: pages.length,
      documentCount: finalDocs.length,
      withBodyCount,
      bodyCoveragePct,
    },
    warnings,
  };
}

export function parseHarJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('File is not valid JSON');
  }
}
