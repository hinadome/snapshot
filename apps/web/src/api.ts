import type { JobSummary, StrategyInfo, TimelineItem } from '@snapshot/core';

const BASE = '';

export type AuthStatus = {
  required: boolean;
  authenticated: boolean;
};

function fetchWithAuth(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, credentials: 'include' });
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** Check whether the API requires a token and whether this browser has a session. */
export async function fetchAuthStatus(): Promise<AuthStatus> {
  return json<AuthStatus>(
    await fetchWithAuth(`${BASE}/api/auth/session`),
  );
}

/** Exchange API token for an HttpOnly session cookie (same-origin). */
export async function establishSession(token: string): Promise<void> {
  await json(
    await fetchWithAuth(`${BASE}/api/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }),
  );
}

export async function clearSession(): Promise<void> {
  await fetchWithAuth(`${BASE}/api/auth/session`, { method: 'DELETE' });
}

export async function fetchStrategies(): Promise<StrategyInfo[]> {
  const data = await json<{ strategies: StrategyInfo[] }>(
    await fetchWithAuth(`${BASE}/api/strategies`),
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
    await fetchWithAuth(`${BASE}/api/jobs`, { method: 'POST', body: form }),
  );
  return data.job;
}

/** Paste HAR JSON, check-result JSON, or harZipBase64 text. */
export async function createJobFromPaste(
  content: string,
  strategyId: string,
): Promise<JobSummary> {
  const data = await json<{ job: JobSummary }>(
    await fetchWithAuth(`${BASE}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, strategyId }),
    }),
  );
  return data.job;
}

export async function fetchJobs(limit = 20): Promise<JobSummary[]> {
  const data = await json<{ jobs: JobSummary[] }>(
    await fetchWithAuth(`${BASE}/api/jobs?limit=${limit}`),
  );
  return data.jobs;
}

export async function fetchJob(id: string): Promise<JobSummary> {
  const data = await json<{ job: JobSummary }>(
    await fetchWithAuth(`${BASE}/api/jobs/${id}`),
  );
  return data.job;
}

export async function fetchTimeline(id: string): Promise<{
  status: string;
  items: TimelineItem[];
}> {
  return json(await fetchWithAuth(`${BASE}/api/jobs/${id}/timeline`));
}

/** Same-origin screenshot URL; auth via HttpOnly cookie when required. */
export function screenshotUrl(path: string): string {
  return `${BASE}${path}`;
}
