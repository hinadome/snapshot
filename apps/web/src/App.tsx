import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JobSummary, StrategyInfo, TimelineItem } from '@snapshot/core';
import {
  createJob,
  fetchJob,
  fetchStrategies,
  fetchTimeline,
  screenshotUrl,
} from './api';

function formatOffset(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `+${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `+${m}m ${rem.toFixed(1)}s`;
}

export function App() {
  const [strategies, setStrategies] = useState<StrategyInfo[]>([]);
  const [strategyId, setStrategyId] = useState('document-navigation');
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [job, setJob] = useState<JobSummary | null>(null);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
  }, [strategyId]);

  const selected = useMemo(
    () => items.find((i) => i.id === selectedId) ?? items[0] ?? null,
    [items, selectedId],
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
          }
        } catch (e: unknown) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })();
    }, 800);
    return () => clearInterval(t);
  }, [job]);

  const onFile = useCallback((f: File | null) => {
    setFile(f);
    setError(null);
  }, []);

  const onSubmit = async () => {
    if (!file) return;
    setSubmitting(true);
    setError(null);
    setItems([]);
    setSelectedId(null);
    try {
      const created = await createJob(file, strategyId);
      setJob(created);
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
              : 'Chrome DevTools → Network → Save all as HAR with content'}
          </span>
          <div style={{ marginTop: '1rem' }}>
            <label className="btn btn-ghost" style={{ display: 'inline-block' }}>
              Choose file
              <input
                type="file"
                accept=".har,.json,application/json"
                hidden
                onChange={(e) => onFile(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>
        </div>

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
            disabled={!file || submitting}
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
          <h2>Timeline</h2>
          <div className="filmstrip">
            {items.map((item) => (
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
                  <span className="label">{item.label}</span>
                  <span className="url" title={item.url}>
                    {item.url}
                  </span>
                </div>
              </article>
            ))}
          </div>

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
