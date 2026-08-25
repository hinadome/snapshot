import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { listStrategies, registerBuiltInStrategies } from '@snapshot/core';
import {
  openInputBuffer,
  resolveSessionInput,
  persistNormalizedHar,
  MAX_INPUT_BYTES,
  type NormalizedInput,
} from '@snapshot/replay';
import { v4 as uuidv4 } from 'uuid';
import {
  createJob,
  getJob,
  loadJobFromDisk,
  listJobs,
  toSummary,
} from './job-store.js';
import { harPath, screenshotFile, corsOrigins } from './paths.js';
import { enqueueJob } from './worker.js';
import { mountWebStatic } from './static-web.js';

registerBuiltInStrategies();

export const app = new Hono();

const origins = corsOrigins();
app.use(
  '*',
  cors({
    origin:
      origins === '*'
        ? (origin) => origin || '*'
        : origins.length
          ? origins
          : ['http://localhost:5173', 'http://127.0.0.1:5173'],
  }),
);

app.get('/api/health', (c) => c.json({ ok: true }));

app.get('/api/strategies', (c) => {
  return c.json({ strategies: listStrategies() });
});

app.get('/api/jobs', async (c) => {
  const limit = Number(c.req.query('limit') ?? 20);
  const jobs = await listJobs(Number.isFinite(limit) ? limit : 20);
  return c.json({ jobs });
});

async function createJobFromNormalized(
  normalized: NormalizedInput,
  strategyId: string,
  originalFilename: string,
) {
  const id = uuidv4();
  const sourceInfo = normalized.sourceInfo;
  try {
    persistNormalizedHar(normalized, harPath(id));
  } finally {
    normalized.cleanup?.();
  }

  const job = await createJob({
    id,
    strategyId,
    originalFilename,
    harBytes: await readFile(harPath(id)),
    harSource: sourceInfo,
  });
  enqueueJob(id);
  return job;
}

app.post('/api/jobs', async (c) => {
  const contentType = c.req.header('content-type') ?? '';

  // JSON / paste: { strategyId?, content? } | { strategyId?, harZipBase64? } | raw HAR
  if (
    contentType.includes('application/json') ||
    contentType.includes('text/plain')
  ) {
    let strategyId = 'document-navigation';
    let payload = '';

    if (contentType.includes('application/json')) {
      const body = await c.req.json().catch(() => null);
      if (!body || typeof body !== 'object') {
        return c.json({ error: 'Expected JSON object' }, 400);
      }
      const record = body as Record<string, unknown>;
      if (typeof record.strategyId === 'string' && record.strategyId) {
        strategyId = record.strategyId;
      }

      if (typeof record.content === 'string' && record.content.trim()) {
        payload = record.content;
      } else if (record.content && typeof record.content === 'object') {
        // curl often embeds HAR as an object: {"content":{"log":{...}}}
        payload = JSON.stringify(record.content);
      } else if (
        typeof record.harZipBase64 === 'string' &&
        record.harZipBase64.trim()
      ) {
        payload = JSON.stringify({ harZipBase64: record.harZipBase64 });
      } else if (typeof record.har === 'string' && record.har.trim()) {
        payload = record.har.trim().startsWith('{')
          ? record.har
          : JSON.stringify({ har: record.har });
      } else if (record.har && typeof record.har === 'object') {
        payload = JSON.stringify(record.har);
      } else if (record.log && typeof record.log === 'object') {
        // Raw HAR body (optionally with strategyId sibling — strip for ingest)
        const { strategyId: _s, ...harBody } = record;
        payload = JSON.stringify(
          harBody.log ? harBody : { log: record.log },
        );
      } else {
        return c.json(
          {
            error:
              'JSON body must include content, harZipBase64, har, or a HAR log object',
          },
          400,
        );
      }
    } else {
      payload = await c.req.text();
      const strategyHeader = c.req.header('x-strategy-id');
      if (strategyHeader) strategyId = strategyHeader;
    }

    if (!payload.trim()) {
      return c.json({ error: 'Empty payload' }, 400);
    }
    if (Buffer.byteLength(payload, 'utf8') > MAX_INPUT_BYTES) {
      return c.json({ error: 'Payload exceeds 200MB limit' }, 400);
    }

    try {
      const normalized = resolveSessionInput(payload);
      const job = await createJobFromNormalized(
        normalized,
        strategyId,
        'paste.json',
      );
      return c.json({ job: toSummary(job) }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  }

  if (!contentType.includes('multipart/form-data')) {
    return c.json(
      {
        error:
          'Expected multipart/form-data, application/json, or text/plain',
      },
      400,
    );
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
  const lower = name.toLowerCase();
  const allowed =
    lower.endsWith('.har') ||
    lower.endsWith('.json') ||
    lower.endsWith('.zip') ||
    lower.endsWith('.har.zip') ||
    lower.endsWith('.txt');

  if (!allowed) {
    return c.json(
      {
        error:
          'Upload a .har, .har.zip, check-result JSON, or base64 text file.',
      },
      400,
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.byteLength === 0) {
    return c.json({ error: 'Empty file' }, 400);
  }
  if (buf.byteLength > MAX_INPUT_BYTES) {
    return c.json({ error: 'File exceeds 200MB limit' }, 400);
  }

  try {
    const normalized = openInputBuffer(buf, name);
    const job = await createJobFromNormalized(normalized, strategyId, name);
    return c.json({ job: toSummary(job) }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
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

// Same-origin UI for production (VM / container). Keep after /api routes.
mountWebStatic(app);