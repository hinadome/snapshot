import type { JobSummary, StrategyInfo, TimelineItem } from '@snapshot/core';

const BASE = '';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchStrategies(): Promise<StrategyInfo[]> {
  const data = await json<{ strategies: StrategyInfo[] }>(
    await fetch(`${BASE}/api/strategies`),
  );
  return data.strategies;
}

export async function createJob(
  file: File,
  strategyId: string,
): Promise<JobSummary> {
  const form = new FormData();
  form.append('file', file);
  form.append('strategyId', strategyId);
  const data = await json<{ job: JobSummary }>(
    await fetch(`${BASE}/api/jobs`, { method: 'POST', body: form }),
  );
  return data.job;
}

/** Paste HAR JSON, check-result JSON, or harZipBase64 text. */
export async function createJobFromPaste(
  content: string,
  strategyId: string,
): Promise<JobSummary> {
  const data = await json<{ job: JobSummary }>(
    await fetch(`${BASE}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, strategyId }),
    }),
  );
  return data.job;
}

export async function fetchJobs(limit = 20): Promise<JobSummary[]> {
  const data = await json<{ jobs: JobSummary[] }>(
    await fetch(`${BASE}/api/jobs?limit=${limit}`),
  );
  return data.jobs;
}

export async function fetchJob(id: string): Promise<JobSummary> {
  const data = await json<{ job: JobSummary }>(
    await fetch(`${BASE}/api/jobs/${id}`),
  );
  return data.job;
}

export async function fetchTimeline(id: string): Promise<{
  status: string;
  items: TimelineItem[];
}> {
  return json(await fetch(`${BASE}/api/jobs/${id}/timeline`));
}

export function screenshotUrl(path: string): string {
  return `${BASE}${path}`;
}
