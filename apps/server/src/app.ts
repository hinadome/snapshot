import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { listStrategies, registerBuiltInStrategies } from '@snapshot/core';
import { v4 as uuidv4 } from 'uuid';
import {
  createJob,
  getJob,
  loadJobFromDisk,
  toSummary,
} from './job-store.js';
import { screenshotFile } from './paths.js';
import { enqueueJob } from './worker.js';

registerBuiltInStrategies();

export const app = new Hono();

app.use(
  '*',
  cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  }),
);

app.get('/api/health', (c) => c.json({ ok: true }));

app.get('/api/strategies', (c) => {
  return c.json({ strategies: listStrategies() });
});

app.post('/api/jobs', async (c) => {
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return c.json({ error: 'Expected multipart/form-data' }, 400);
  }

  const form = await c.req.parseBody();
  const file = form['file'];
  const strategyId =
    typeof form['strategyId'] === 'string' && form['strategyId']
      ? form['strategyId']
      : 'document-navigation';

  if (!file || typeof file === 'string') {
    return c.json({ error: 'Missing file field' }, 400);
  }

  const name = file.name || 'capture.har';
  if (!name.toLowerCase().endsWith('.har') && !name.toLowerCase().endsWith('.json')) {
    return c.json(
      { error: 'Upload a .har (or HAR JSON) file. Zip HARs: extract first for v1.' },
      400,
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.byteLength === 0) {
    return c.json({ error: 'Empty file' }, 400);
  }
  if (buf.byteLength > 200 * 1024 * 1024) {
    return c.json({ error: 'HAR exceeds 200MB limit' }, 400);
  }

  // Quick sanity check
  const head = buf.subarray(0, 64).toString('utf8').trimStart();
  if (!head.startsWith('{')) {
    return c.json({ error: 'File does not look like JSON HAR' }, 400);
  }

  const id = uuidv4();
  const job = await createJob({
    id,
    strategyId,
    originalFilename: name,
    harBytes: buf,
  });
  enqueueJob(id);
  return c.json({ job: toSummary(job) }, 201);
});

app.get('/api/jobs/:id', async (c) => {
  const id = c.req.param('id');
  let job = getJob(id);
  if (!job) job = (await loadJobFromDisk(id)) ?? undefined;
  if (!job) return c.json({ error: 'Job not found' }, 404);
  return c.json({ job: toSummary(job) });
});

app.get('/api/jobs/:id/timeline', async (c) => {
  const id = c.req.param('id');
  let job = getJob(id);
  if (!job) job = (await loadJobFromDisk(id)) ?? undefined;
  if (!job) return c.json({ error: 'Job not found' }, 404);

  const items = job.results.map((r) => ({
    id: r.id,
    atMs: r.atMs,
    label: r.label,
    url: r.url,
    kind: r.kind,
    screenshotUrl: `/api/jobs/${id}/screenshots/${encodeURIComponent(r.id)}.png`,
    warnings: r.warnings,
    error: r.error,
  }));

  return c.json({
    jobId: id,
    status: job.status,
    strategyId: job.strategyId,
    items,
  });
});

app.get('/api/jobs/:id/screenshots/:file', async (c) => {
  const id = c.req.param('id');
  const file = c.req.param('file');
  if (!file.toLowerCase().endsWith('.png')) {
    return c.json({ error: 'Screenshot not found' }, 404);
  }
  const captureId = file.slice(0, -4);
  if (!/^[\w.-]+$/.test(captureId)) {
    return c.json({ error: 'Invalid capture id' }, 400);
  }
  const path = screenshotFile(id, captureId);
  try {
    const data = await readFile(path);
    return new Response(data, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch {
    return c.json({ error: 'Screenshot not found' }, 404);
  }
});
