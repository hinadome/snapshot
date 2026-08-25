import { mkdir, writeFile } from 'node:fs/promises';
import type {
  CapturePoint,
  CaptureResult,
  HarIndex,
  HarSourceInfo,
  JobStatus,
  JobSummary,
} from '@snapshot/core';
import { harPath, metaPath, jobDir, screenshotsDir } from './paths.js';

export type JobRecord = {
  id: string;
  status: JobStatus;
  strategyId: string;
  createdAt: string;
  updatedAt: string;
  progress: {
    current: number;
    total: number;
    message: string;
  };
  harStats?: HarIndex['stats'];
  harSource?: HarSourceInfo;
  indexWarnings: string[];
  capturePoints: CapturePoint[];
  results: CaptureResult[];
  warnings: string[];
  error?: string;
  originalFilename: string;
};

const memory = new Map<string, JobRecord>();

export function toSummary(job: JobRecord): JobSummary {
  return {
    id: job.id,
    status: job.status,
    strategyId: job.strategyId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    progress: job.progress,
    harStats: job.harStats,
    harSource: job.harSource,
    warnings: [...job.indexWarnings, ...job.warnings],
    error: job.error,
  };
}

export async function createJob(params: {
  id: string;
  strategyId: string;
  originalFilename: string;
  harBytes: Buffer;
  harSource?: HarSourceInfo;
}): Promise<JobRecord> {
  const now = new Date().toISOString();
  await mkdir(screenshotsDir(params.id), { recursive: true });
  await mkdir(jobDir(params.id), { recursive: true });
  await writeFile(harPath(params.id), params.harBytes);

  const job: JobRecord = {
    id: params.id,
    status: 'queued',
    strategyId: params.strategyId,
    createdAt: now,
    updatedAt: now,
    progress: { current: 0, total: 0, message: 'Queued' },
    harSource: params.harSource,
    indexWarnings: [],
    capturePoints: [],
    results: [],
    warnings: [],
    originalFilename: params.originalFilename,
  };

  memory.set(job.id, job);
  await persist(job);
  return job;
}

export function getJob(id: string): JobRecord | undefined {
  return memory.get(id);
}

export async function updateJob(
  id: string,
  patch: Partial<JobRecord>,
): Promise<JobRecord> {
  const job = memory.get(id);
  if (!job) throw new Error(`Job not found: ${id}`);
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  memory.set(id, job);
  await persist(job);
  return job;
}

async function persist(job: JobRecord): Promise<void> {
  await mkdir(jobDir(job.id), { recursive: true });
  await writeFile(metaPath(job.id), JSON.stringify(job, null, 2), 'utf8');
}

export async function loadJobFromDisk(id: string): Promise<JobRecord | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(metaPath(id), 'utf8');
    const job = JSON.parse(text) as JobRecord;
    memory.set(id, job);
    return job;
  } catch {
    return null;
  }
}

/** List recent jobs from memory + disk, newest first. */
export async function listJobs(limit = 20): Promise<JobSummary[]> {
  const { readdir } = await import('node:fs/promises');
  const { JOBS_DIR } = await import('./paths.js');

  let ids: string[] = [];
  try {
    ids = await readdir(JOBS_DIR);
  } catch {
    ids = [];
  }

  const seen = new Set<string>();
  const jobs: JobRecord[] = [];

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const fromMem = memory.get(id);
    if (fromMem) {
      jobs.push(fromMem);
      continue;
    }
    const fromDisk = await loadJobFromDisk(id);
    if (fromDisk) jobs.push(fromDisk);
  }

  for (const [id, job] of memory) {
    if (seen.has(id)) continue;
    jobs.push(job);
  }

  jobs.sort(
    (a, b) =>
      Date.parse(b.updatedAt || b.createdAt) -
      Date.parse(a.updatedAt || a.createdAt),
  );

  return jobs.slice(0, Math.max(1, limit)).map(toSummary);
}
