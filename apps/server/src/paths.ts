import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Monorepo root (apps/server/src -> ../../..) */
export const ROOT_DIR = join(__dirname, '../../..');
export const DATA_DIR = process.env.SNAPSHOT_DATA_DIR ?? join(ROOT_DIR, 'data');
export const JOBS_DIR = join(DATA_DIR, 'jobs');
export const PORT = Number(process.env.PORT ?? 8787);

/** Kept after a successful job; everything else in the job dir is upload input. */
export const JOB_KEEP_NAMES = new Set(['job.json', 'screenshots']);

export function jobDir(jobId: string): string {
  return join(JOBS_DIR, jobId);
}

export function harPath(jobId: string): string {
  return join(jobDir(jobId), 'capture.har');
}

export function metaPath(jobId: string): string {
  return join(jobDir(jobId), 'job.json');
}

export function screenshotsDir(jobId: string): string {
  return join(jobDir(jobId), 'screenshots');
}

export function screenshotFile(jobId: string, captureId: string): string {
  return join(screenshotsDir(jobId), `${captureId}.png`);
}

export async function ensureDataDirs(): Promise<void> {
  await mkdir(JOBS_DIR, { recursive: true });
}

/**
 * After screenshots succeed, the HAR and zip body sidecars are unused.
 * Remove them; keep job.json + screenshots/ for the timeline UI.
 */
export async function deleteUploadedHarArtifacts(jobId: string): Promise<void> {
  const { readdir, rm } = await import('node:fs/promises');
  const dir = jobDir(jobId);
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  await Promise.all(
    entries.map(async (name) => {
      if (JOB_KEEP_NAMES.has(name)) return;
      await rm(join(dir, name), { recursive: true, force: true });
    }),
  );
}
