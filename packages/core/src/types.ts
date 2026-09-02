/** Capture point kinds — extensible for future strategies */
export type CaptureKind = 'navigation' | 'milestone' | 'periodic';

export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle';

export type CapturePoint = {
  id: string;
  url: string;
  /** Milliseconds from session start */
  atMs: number;
  label: string;
  waitUntil: WaitUntil;
  kind: CaptureKind;
  pageref?: string;
  fullPage?: boolean;
  stage?: 'commit' | 'domcontentloaded' | 'load' | 'networkidle' | 'fullpage' | 'scroll';
  scrollIndex?: number;
};

export type HarSourceInfo = {
  source: string;
  creatorName: string | null;
  entryCount: number;
  pageCount: number;
  withBody: number;
  bodyCoveragePct: number;
  hasDocument: boolean;
};

export type CaptureResult = {
  id: string;
  url: string;
  atMs: number;
  label: string;
  kind: CaptureKind;
  screenshotPath: string;
  warnings: string[];
  error?: string;
};

export type JobStatus =
  | 'queued'
  | 'indexing'
  | 'planning'
  | 'capturing'
  | 'completed'
  | 'failed';

export type StrategyInfo = {
  id: string;
  name: string;
  description: string;
};

export type HarPage = {
  id: string;
  title: string;
  startedDateTime: string;
  startedMs: number;
};

export type HarEntrySummary = {
  index: number;
  pageref?: string;
  startedDateTime: string;
  startedMs: number;
  method: string;
  url: string;
  status: number;
  mimeType: string;
  hasBody: boolean;
  isDocument: boolean;
};

export type DocumentNavigation = {
  entryIndex: number;
  pageref?: string;
  url: string;
  startedDateTime: string;
  startedMs: number;
  title: string;
  mimeType: string;
  status: number;
  hasBody: boolean;
};

export type HarIndex = {
  version: string;
  creator?: string;
  sourceInfo?: HarSourceInfo;
  sessionStartMs: number;
  pages: HarPage[];
  entries: HarEntrySummary[];
  documents: DocumentNavigation[];
  stats: {
    entryCount: number;
    pageCount: number;
    documentCount: number;
    withBodyCount: number;
    bodyCoveragePct: number;
  };
  warnings: string[];
};

export type TimelineItem = {
  id: string;
  atMs: number;
  label: string;
  url: string;
  kind: CaptureKind;
  screenshotUrl: string;
  warnings: string[];
  error?: string;
};

export type JobSummary = {
  id: string;
  status: JobStatus;
  strategyId: string;
  /** When true (default), cross-origin responses must pass CORS checks during replay. */
  enforceCors?: boolean;
  createdAt: string;
  updatedAt: string;
  progress: {
    current: number;
    total: number;
    message: string;
  };
  harStats?: HarIndex['stats'];
  harSource?: HarSourceInfo;
  warnings: string[];
  error?: string;
};
