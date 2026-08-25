import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CaptureKind,
  JobSummary,
  StrategyInfo,
  TimelineItem,
} from '@snapshot/core';
import {
  createJob,
  createJobFromPaste,
  fetchJob,
  fetchJobs,
  fetchStrategies,
  fetchTimeline,
  screenshotUrl,
} from './api';

type KindFilter = 'all' | CaptureKind;

function formatOffset(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `+${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `+${m}m ${rem.toFixed(1)}s`;
}

function kindClass(kind: string): string {
  if (kind === 'milestone') return 'kind-milestone';
  if (kind === 'periodic') return 'kind-periodic';
  return 'kind-navigation';
}

function shortJobLabel(job: JobSummary): string {
  const when = new Date(job.updatedAt || job.createdAt).toLocaleString();
  const docs = job.harStats?.documentCount;
  const strategy = job.strategyId;
  return `${when} · ${strategy}${docs != null ? ` · ${docs} doc(s)` : ''} · ${job.status}`;
}

export function App() {
  const [strategies, setStrategies] = useState<StrategyInfo[]>([]);
  const [strategyId, setStrategyId] = useState('document-navigation');
  const [file, setFile] = useState<File | null>(null);
  const [paste, setPaste] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [job, setJob] = useState<JobSummary | null>(null);
  const [recentJobs, setRecentJobs] = useState<JobSummary[]>([]);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const refreshRecent = useCallback(() => {
    void fetchJobs(15)
      .then(setRecentJobs)
      .catch(() => {
        /* ignore — server may be starting */
      });
  }, []);

  useEffect(() => {
    void fetchStrategies()
      .then((list) => {
        setStrategies(list);
        if (list[0] && !list.find((s) => s.id === strategyId)) {
          setStrategyId(list[0].id);
        }
      })
      .catch((e: unknown) => {
        setError(
          e instanceof Error
            ? e.message
            : 'Could not reach API. Is the server running?',
        );
      });
    refreshRecent();
  }, [strategyId, refreshRecent]);

  const filteredItems = useMemo(() => {
    if (kindFilter === 'all') return items;
    return items.filter((i) => i.kind === kindFilter);
  }, [items, kindFilter]);

  const selected = useMemo(
    () =>
      filteredItems.find((i) => i.id === selectedId) ??
      filteredItems[0] ??
      null,
    [filteredItems, selectedId],
  );

  useEffect(() => {
    if (!job || job.status === 'completed' || job.status === 'failed') return;
    const t = setInterval(() => {
      void (async () => {
        try {
          const next = await fetchJob(job.id);
          setJob(next);
          if (next.status === 'completed') {
            const tl = await fetchTimeline(job.id);
            setItems(tl.items);
            setSelectedId(tl.items[0]?.id ?? null);
            refreshRecent();
          }
          if (next.status === 'failed') refreshRecent();
        } catch (e: unknown) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })();
    }, 800);
    return () => clearInterval(t);
  }, [job, refreshRecent]);

  const onFile = useCallback((f: File | null) => {
    setFile(f);
    if (f) setPaste('');
    setError(null);
  }, []);

  const loadExistingJob = async (id: string) => {
    setError(null);
    setItems([]);
    setSelectedId(null);
    try {
      const next = await fetchJob(id);
      setJob(next);
      if (next.status === 'completed') {
        const tl = await fetchTimeline(id);
        setItems(tl.items);
        setSelectedId(tl.items[0]?.id ?? null);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const canSubmit = Boolean(file) || paste.trim().length > 0;

  const onSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setItems([]);
    setSelectedId(null);
    try {
      const created = file
        ? await createJob(file, strategyId)
        : await createJobFromPaste(paste.trim(), strategyId);
      setJob(created);
      refreshRecent();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const progressPct =
    job && job.progress.total > 0
      ? Math.round((job.progress.current / job.progress.total) * 100)
      : job?.status === 'completed'
        ? 100
        : job
          ? 8
          : 0;

  const availableKinds = useMemo(() => {
    const set = new Set(items.map((i) => i.kind));
    return [...set];
  }, [items]);

  return (
    <div className="app">
      <header className="brand">
        <h1>Snapshot</h1>
        <p>
          Upload a HAR with content. Snapshot reconstructs each navigated page
          offline with Playwright and shows screenshots in capture order.
        </p>
      </header>

      <section className="panel">
        <div
          className={`dropzone${dragOver ? ' active' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) onFile(f);
          }}
        >
          <strong>
            {file ? file.name : 'Drop a .har file here'}
          </strong>
          <span>
            {file
              ? `${(file.size / (1024 * 1024)).toFixed(2)} MB`
              : 'Chrome DevTools → Network → Save all as HAR with content (.har or .har.zip)'}
          </span>
          <div style={{ marginTop: '1rem' }}>
            <label className="btn btn-ghost" style={{ display: 'inline-block' }}>
              Choose file
              <input
                type="file"
                accept=".har,.json,.zip,.txt,application/json,application/zip,text/plain"
                hidden
                onChange={(e) => onFile(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>
        </div>

        <div className="paste-toggle">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setShowPaste((v) => !v)}
          >
            {showPaste ? 'Hide paste' : 'Or paste HAR / check JSON / base64'}
          </button>
        </div>

        {showPaste ? (
          <div className="paste-field">
            <label htmlFor="paste">
              Paste HAR JSON, URL-checker result, or harZipBase64
            </label>
            <textarea
              id="paste"
              rows={8}
              value={paste}
              placeholder='{"log":{…}}  or  {"harZipBase64":"…"}  or raw base64'
              onChange={(e) => {
                setPaste(e.target.value);
                if (e.target.value.trim()) setFile(null);
                setError(null);
              }}
            />
          </div>
        ) : null}

        <div className="controls">
          <div className="field">
            <label htmlFor="strategy">Capture strategy</label>
            <select
              id="strategy"
              value={strategyId}
              onChange={(e) => setStrategyId(e.target.value)}
            >
              {strategies.length === 0 ? (
                <option value="document-navigation">Document navigation</option>
              ) : (
                strategies.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))
              )}
            </select>
          </div>
          <button
            className="btn"
            type="button"
            disabled={!canSubmit || submitting}
            onClick={() => void onSubmit()}
          >
            {submitting ? 'Uploading…' : 'Reconstruct pages'}
          </button>
        </div>

        {strategies.find((s) => s.id === strategyId)?.description ? (
          <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginBottom: 0 }}>
            {strategies.find((s) => s.id === strategyId)?.description}
          </p>
        ) : null}

        {recentJobs.length > 0 ? (
          <div className="field recent-jobs">
            <label htmlFor="recent">Recent jobs</label>
            <select
              id="recent"
              value={job?.id ?? ''}
              onChange={(e) => {
                const id = e.target.value;
                if (id) void loadExistingJob(id);
              }}
            >
              <option value="">Open a previous job…</option>
              {recentJobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {shortJobLabel(j)}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {error ? <div className="error">{error}</div> : null}

        {job ? (
          <div className="progress">
            <div className="meta">
              <span>status: {job.status}</span>
              <span>{job.progress.message}</span>
              {job.harStats ? (
                <span>
                  entries {job.harStats.entryCount} · docs{' '}
                  {job.harStats.documentCount} · bodies{' '}
                  {job.harStats.bodyCoveragePct}%
                </span>
              ) : null}
              {job.harSource ? (
                <span>
                  source: {job.harSource.source}
                  {job.harSource.creatorName
                    ? ` (${job.harSource.creatorName})`
                    : ''}
                </span>
              ) : null}
            </div>
            <div className="progress-bar" aria-hidden>
              <i style={{ width: `${progressPct}%` }} />
            </div>
            {job.warnings.length > 0 ? (
              <div className="warnings">
                <strong>Notes</strong>
                <ul>
                  {job.warnings.slice(0, 8).map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {job.error ? <div className="error">{job.error}</div> : null}
          </div>
        ) : null}
      </section>

      {items.length > 0 ? (
        <section className="timeline">
          <div className="timeline-header">
            <h2>Timeline</h2>
            <div className="kind-filters" role="group" aria-label="Filter by kind">
              <button
                type="button"
                className={kindFilter === 'all' ? 'active' : ''}
                onClick={() => setKindFilter('all')}
              >
                All ({items.length})
              </button>
              {availableKinds.map((k) => {
                const count = items.filter((i) => i.kind === k).length;
                return (
                  <button
                    key={k}
                    type="button"
                    className={kindFilter === k ? 'active' : ''}
                    onClick={() => setKindFilter(k)}
                  >
                    {k} ({count})
                  </button>
                );
              })}
            </div>
          </div>

          {filteredItems.length === 0 ? (
            <p className="empty-filter">No frames for this filter.</p>
          ) : (
            <div className="filmstrip">
              {filteredItems.map((item) => (
                <article
                  key={item.id}
                  className={`frame${selected?.id === item.id ? ' selected' : ''}`}
                >
                  <button
                    type="button"
                    className="thumb"
                    onClick={() => setSelectedId(item.id)}
                  >
                    <img
                      src={screenshotUrl(item.screenshotUrl)}
                      alt={item.label}
                      loading="lazy"
                    />
                  </button>
                  <div className="info">
                    <span className="time">{formatOffset(item.atMs)}</span>
                    <span className={`kind-badge ${kindClass(item.kind)}`}>
                      {item.kind}
                    </span>
                    <span className="label">{item.label}</span>
                    <span className="url" title={item.url}>
                      {item.url}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}

          {selected ? (
            <div className="detail">
              <img
                src={screenshotUrl(selected.screenshotUrl)}
                alt={selected.label}
              />
              <div className="caption">
                <div>
                  <strong>{selected.label}</strong> · {formatOffset(selected.atMs)}{' '}
                  · <code>{selected.kind}</code>
                </div>
                <div>
                  <code>{selected.url}</code>
                </div>
                {selected.warnings.length > 0 ? (
                  <div className="warnings">
                    <ul>
                      {selected.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {selected.error ? (
                  <div className="error">{selected.error}</div>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
