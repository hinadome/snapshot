# Snapshot — Integration Implementation Plan

Integrate HAR replay tooling into the Snapshot monorepo via shared `@snapshot/replay`.

> User-facing history: **[CHANGELOG.md](CHANGELOG.md)** · User guide: **[README.md](README.md)**

## Architecture

```
packages/core     → types, HarIndex, CaptureStrategy (no Playwright)
packages/replay   → ingest, inspect, HAR router, Playwright capture
apps/server       → API + job worker (uses core + replay)
apps/web          → upload UI + timeline
scripts/          → thin CLI wrapper (uses core + replay)
```

## Phase 1 — Shared replay engine

- [x] Create this IMPLEMENT.md
- [x] Create `packages/replay` package scaffold
- [x] Move `har-router.ts` from `apps/server` → `packages/replay/src/router/`
- [x] Port ingest from script → `packages/replay/src/ingest/`
- [x] Port inspect from script → `packages/replay/src/inspect/`
- [x] Implement capture + browser helpers
- [x] Merge script improvements into `@snapshot/core`
- [x] Refactor `apps/server` to use `@snapshot/replay`
- [x] Replace `script/replay-har.mjs` with slim `scripts/replay-har.ts`
- [x] Tests + README

**Exit criteria:** Same HAR + `document-navigation` → app and CLI produce identical capture points and screenshots.

## Phase 2 — New capture strategies

- [x] `page-timing` strategy (commit → DCL → load → networkidle → fullpage)
- [x] Port progressive + scroll capture into `@snapshot/replay`
- [x] `scroll-viewport` strategy
- [x] Worker: multiple PNGs per navigation via `executeCapturePlan`
- [x] Web UI: timeline shows `milestone` / `periodic` kind badges + HAR source
- [x] CLI: `--strategy page-timing`, `--scroll`

## Phase 3 — Input parity + polish

- [x] Web: optional check-result JSON / base64 paste
- [x] API: `POST /api/jobs` accepts `application/json` / `text/plain` paste payloads
- [x] Job detail: show `HarSourceInfo` in UI
- [x] README: full strategy + ingest guide
- [x] Playwright integration test (`packages/replay` capture integration)
- [x] Accept JSON `content` as object (curl + jq expansion)

## Phase 4 — UX polish

- [x] `GET /api/jobs` — list recent jobs from disk
- [x] UI: recent jobs picker to reopen completed work
- [x] UI: timeline kind filter (all / navigation / milestone / periodic)
- [x] gitignore CLI `har-screenshots/` output

## Script enhancements

- [x] Fix path: `script/` → `scripts/`
- [x] Unified router (not raw `routeFromHAR` for DevTools HAR)
- [x] `--strategy <id>` (all pages via strategy plan)
- [x] Validate zip HARs on ingest
- [x] Input size limits (200MB)
- [x] Node zip lib (`fflate`, no system `unzip`)
- [x] Unit tests for ingest + inspect
- [x] Port progressive/scroll capture from old script (Phase 2)
- [x] Integration test with Playwright
- [x] Playwright `.har.zip` with `_file` body sidecars: extract full archive + persist assets

## Deleted in Phase 1

- `apps/server/src/replay.ts`
- `apps/server/src/har-router.ts`
- `script/replay-har.mjs` (replaced by `scripts/replay-har.ts`)
