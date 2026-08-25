export type HarSource =
  | 'devtools-chrome'
  | 'devtools-firefox'
  | 'playwright'
  | 'har'
  | `har:${string}`;

export type HarSourceInfo = {
  source: HarSource;
  creatorName: string | null;
  entryCount: number;
  pageCount: number;
  withBody: number;
  bodyCoveragePct: number;
  hasDocument: boolean;
};

type HarData = {
  log?: {
    creator?: { name?: string; version?: string };
    pages?: unknown[];
    entries?: Array<{
      _resourceType?: string;
      request?: { url?: string };
      response?: { content?: { mimeType?: string; text?: string; _file?: string } };
    }>;
  };
};

export function inspectHarData(data: unknown): HarSourceInfo {
  const har = data as HarData;
  const log = har?.log ?? {};
  const creatorName = String(log.creator?.name ?? '');
  const entries = Array.isArray(log.entries) ? log.entries : [];
  const pages = Array.isArray(log.pages) ? log.pages : [];

  let source: HarSource = 'har';
  const lower = creatorName.toLowerCase();
  if (lower.includes('webinspector') || lower.includes('chrome')) {
    source = 'devtools-chrome';
  } else if (lower.includes('firefox')) {
    source = 'devtools-firefox';
  } else if (lower.includes('playwright')) {
    source = 'playwright';
  } else if (creatorName) {
    source = `har:${creatorName}`;
  }

  let withBody = 0;
  for (const entry of entries) {
    const content = entry?.response?.content ?? {};
    if (content.text != null || content._file) withBody += 1;
  }

  const hasDocument = entries.some(
    (e) =>
      e?._resourceType === 'document' ||
      String(e?.response?.content?.mimeType ?? '').includes('html'),
  );

  const entryCount = entries.length;
  return {
    source,
    creatorName: creatorName || null,
    entryCount,
    pageCount: pages.length,
    withBody,
    bodyCoveragePct:
      entryCount === 0 ? 0 : Math.round((withBody / entryCount) * 1000) / 10,
    hasDocument,
  };
}

export function describeHarSource(info: HarSourceInfo): string {
  switch (info.source) {
    case 'devtools-chrome':
      return 'Chrome/Edge DevTools HAR (WebInspector)';
    case 'devtools-firefox':
      return 'Firefox DevTools HAR';
    case 'playwright':
      return `Playwright HAR (${info.creatorName ?? 'Playwright'})`;
    default:
      return info.creatorName
        ? `HAR (creator: ${info.creatorName})`
        : 'HAR JSON';
  }
}
