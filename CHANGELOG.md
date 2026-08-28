# Changelog

All notable changes to **Snapshot** are documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/). Versioning follows the monorepo `package.json` version.

---

## [Unreleased]

### Added
- Production deploy: `deploy/vm-deploy.sh` (VM + systemd), `deploy/container-deploy.sh` (Docker Compose), `deploy/Dockerfile`, and [DEPLOYMENT.md](DEPLOYMENT.md)
- API serves built web UI on the same port in production (`SNAPSHOT_WEB_DIST`); configurable `HOST` bind (`127.0.0.1` behind nginx)
- Configurable CORS via `SNAPSHOT_CORS_ORIGINS`
- Optional API auth via `SNAPSHOT_API_TOKEN` (Bearer header or HttpOnly session cookie from `POST /api/auth/session`)
- Job ID validation, queue depth cap (`SNAPSHOT_MAX_QUEUE`), sanitized API errors, security response headers
- nginx front: `deploy/nginx-setup.sh` — **additive** vhost; `--http` (port 80), Let's Encrypt, self-signed, or custom certs; rate-limit zone install
- Container parity: `--host-nginx` / `--nginx` with `--http` or HTTPS; `--public` (requires token); Compose `init`, `mem_limit`, default `SNAPSHOT_BIND=127.0.0.1`
- VM Node auto-install via `deploy/lib/ensure-node.sh` (default major `20`); VM `--public` flag

---

## [0.1.0] — 2026-08-24

Initial local-first HAR → screenshot application: web UI, API worker, shared replay engine, CLI, and post-capture HAR cleanup.

### Added

#### Product
- Local web app to upload HAR captures, reconstruct pages offline with Playwright, and show screenshots in time order
- Capture strategies (pluggable via `@snapshot/core`):
  - `document-navigation` — one full-page shot per main-frame navigation (default)
  - `page-timing` — commit → DOMContentLoaded → load → networkidle → fullpage
  - `scroll-viewport` — load frame, viewport scroll frames, then fullpage
- Timeline UI with `kind` badges (`navigation` / `milestone` / `periodic`) and kind filters
- Recent jobs picker (`GET /api/jobs`) to reopen completed work
- Paste path for HAR JSON, check-result JSON, or `harZipBase64` / data URLs
- CLI: `pnpm replay --` (same engine as the server)

#### Packages
- **`@snapshot/core`** — HAR indexing, `CaptureStrategy` registry, shared DTOs (`CapturePoint`, `HarIndex`, `HarSourceInfo`, …)
- **`@snapshot/replay`** — ingest, HAR source inspect, custom fulfill router, progressive/scroll capture, `executeCapturePlan`
- **`apps/server`** — Hono API + in-process job worker
- **`apps/web`** — Vite + React upload / paste / timeline UI
- **`scripts/replay-har.ts`** — thin CLI over core + replay

#### Ingest / inputs
- DevTools `.har` / `.json`
- Playwright attach **`.har.zip`** (`har.har` + `content._file` body sidecars) — full archive extract and persist
- Check-result JSON (`harZipBase64`, `har`)
- Raw base64 / data URL (paste or file)
- 200MB input size limit; zip via `fflate` (no system `unzip`)

#### Storage
- Jobs under `data/jobs/<id>/` (`SNAPSHOT_DATA_DIR` override)
- After a **successful** API capture, uploaded HAR / zip body sidecars are **deleted**; only `job.json` + `screenshots/` remain for the timeline
- Failed jobs **keep** the HAR for debugging
- CLI `pnpm replay` does not delete the source HAR (writes screenshots to an output directory only)

#### API
| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/health` | Liveness |
| GET | `/api/strategies` | Registered strategies |
| GET | `/api/jobs` | Recent jobs (`?limit=`) |
| POST | `/api/jobs` | Multipart file **or** JSON / text paste |
| GET | `/api/jobs/:id` | Status, progress, `harSource`, warnings |
| GET | `/api/jobs/:id/timeline` | Ordered frames |
| GET | `/api/jobs/:id/screenshots/:id.png` | PNG |

JSON `POST /api/jobs` accepts `content` as a **string or object** (so `curl` + `jq` embedding works), plus `harZipBase64`, `har`, or a raw HAR `log` body.

#### Replay quality
- Custom HAR fulfill router (reliable for Chrome DevTools HARs vs raw `routeFromHAR` alone)
- Main-frame-only navigations (iframes/ads are not separate timeline pages)
- Pathname fallback for GET when query tokens drift
- Strip `content-encoding` / CSP headers on fulfill (decoded bodies)
- Longer render waits before screenshot (`load` / `networkidle` + paint delay)
- Playwright zip: resolve `content._file` from job asset directory

#### Tests & docs
- Unit tests: HAR index, strategies, ingest, URL matching, zip `_file` extract
- Integration test: sample HAR → PNG via Playwright
- `IMPLEMENT.md` — phased build checklist (Phases 1–4 complete)
- `README.md` — user guide (pipeline, strategies, storage lifecycle, API)

### Changed
- Replaced standalone `script/replay-har.mjs` with shared `@snapshot/replay` + slim `scripts/replay-har.ts`
- Server no longer owns local `replay.ts` / `har-router.ts` (moved into `@snapshot/replay`)
- Completed API jobs no longer retain uploaded HAR payloads on disk after screenshots succeed

### Fixed
- JSON job create failing when `content` was a nested object (common with `jq` in curl)
- Playwright `.har.zip` uploads dropping `_file` body sidecars (only `har.har` was extracted)
- Over-capturing iframe/document entries as separate “pages”

### Known limitations
- Offline replay cannot invent missing assets, WebSockets, or post-load SPA clicks
- Dynamic/anti-bot URLs may still miss; pathname matching is best-effort
- Captcha / login flows often incomplete when replayed offline
- No job TTL or delete-job API yet (`job.json` + PNGs accumulate until removed manually)

---

## Implementation history (phases)

Detailed task checklist lives in [`IMPLEMENT.md`](IMPLEMENT.md). Summary:

| Phase | Focus |
|-------|--------|
| **1** | Shared `@snapshot/replay`, server refactor, CLI slim-down |
| **2** | `page-timing` / `scroll-viewport`, progressive capture plan |
| **3** | Paste / JSON API, docs, Playwright integration test |
| **4** | Recent jobs, timeline kind filters, polish |
| **Zip fix** | Full Playwright attach zip extract + asset persist |
| **Cleanup** | Delete uploaded HAR artifacts after successful screenshot jobs |
