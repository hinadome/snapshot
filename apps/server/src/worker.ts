import { readFile } from 'node:fs/promises';
import {
  buildHarIndex,
  parseHarJson,
  requireStrategy,
} from '@snapshot/core';
import { executeCapturePlan } from '@snapshot/replay';
import { getJob, updateJob } from './job-store.js';
import {
  deleteUploadedHarArtifacts,
  harPath,
  jobDir,
  screenshotFile,
} from './paths.js';

const queue: string[] = [];
let running = false;

export function enqueueJob(jobId: string): void {
  queue.push(jobId);
  void pump();
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const id = queue.shift()!;
      await processJob(id);
    }
  } finally {
    running = false;
  }
}

async function processJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) return;

  try {
    await updateJob(jobId, {
      status: 'indexing',
      progress: { current: 0, total: 0, message: 'Indexing HAR…' },
    });

    const text = await readFile(harPath(jobId), 'utf8');
    const raw = parseHarJson(text);
    const index = buildHarIndex(raw);

    await updateJob(jobId, {
      status: 'planning',
      harStats: index.stats,
      harSource: index.sourceInfo,
      indexWarnings: index.warnings,
      progress: {
        current: 0,
        total: 0,
        message: 'Planning capture points…',
      },
    });

    const strategy = requireStrategy(job.strategyId);
    const capturePoints = strategy.plan(index);

    if (capturePoints.length === 0) {
      await updateJob(jobId, {
        status: 'failed',
        capturePoints: [],
        error: 'No capture points produced for this HAR and strategy.',
        progress: { current: 0, total: 0, message: 'Failed' },
      });
      return;
    }

    await updateJob(jobId, {
      status: 'capturing',
      capturePoints,
      progress: {
        current: 0,
        total: capturePoints.length,
        message: `Capturing 0/${capturePoints.length}…`,
      },
    });

    const dir = jobDir(jobId);
    const results = await executeCapturePlan(
      harPath(jobId),
      capturePoints,
      (captureId) => screenshotFile(jobId, captureId),
      {
        harDir: dir,
        headless: true,
        onProgress: async (current, total, label) => {
          await updateJob(jobId, {
            progress: {
              current,
              total,
              message: label,
            },
          });
        },
      },
    );

    await updateJob(jobId, {
      results: [...results],
    });

    const captureWarnings = results.flatMap((r) =>
      r.warnings.map((w) => `[${r.id}] ${w.replace(/\s+/g, ' ').trim()}`),
    );

    await updateJob(jobId, {
      status: 'completed',
      results,
      warnings: captureWarnings,
      progress: {
        current: capturePoints.length,
        total: capturePoints.length,
        message: 'Done',
      },
    });

    // HAR / zip assets are only needed during capture
    await deleteUploadedHarArtifacts(jobId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateJob(jobId, {
      status: 'failed',
      error: message,
      progress: {
        current: 0,
        total: 0,
        message: 'Failed',
      },
    });
    // Keep uploaded HAR on failure for debugging / retry inspection
  }
}
