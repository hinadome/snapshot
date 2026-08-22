# Snapshot

Local web app that reconstructs pages from a HAR file with Playwright and shows screenshots in capture-time order.

HAR files stay on your machine. Playwright runs locally. Nothing is uploaded to a remote server.

## Quick start

```bash
pnpm install
pnpm dev
```

- UI: http://localhost:5173  
- API: http://localhost:8787  

Open the UI, drop a `.har` exported **with content**, and click **Reconstruct pages**.

## Capturing a good HAR

1. Open Chrome (or Edge) DevTools → **Network**
2. Check **Preserve log** if you navigate across pages
3. Browse the sites/pages you care about
4. Right-click the request list → **Save all as HAR with content**

Without response bodies, reconstruction will fail or look empty. Snapshot reports body-coverage % after indexing.

## How it works

1. **Upload** — HAR is stored under `data/jobs/<id>/`
2. **Index** — `@snapshot/core` finds document navigations and timings
3. **Plan** — a **capture strategy** emits ordered `CapturePoint`s
4. **Replay** — a custom HAR router fulfills requests from captured responses (`abort` when missing)
5. **Timeline** — screenshots are shown by `atMs` from session start

### Capture strategies

v1 ships **`document-navigation`**: one screenshot per navigated HTML document.

Strategies are pluggable. The job API accepts `strategyId`, and `GET /api/strategies` lists registered ones so the UI can grow without API changes.

#### Adding a strategy

1. Implement `CaptureStrategy` in `packages/core`:

```ts
import type { CaptureStrategy } from '../strategy.js';
import type { CapturePoint, HarIndex } from '../types.js';

export class PageTimingStrategy implements CaptureStrategy {
  readonly id = 'page-timing';
  readonly name = 'Page timings';
  readonly description = 'Screenshots at DOMContentLoaded and load per page.';

  plan(index: HarIndex): CapturePoint[] {
    // return CapturePoint[] with kind: 'milestone'
    return [];
  }
}
```

2. Register it in `registerBuiltInStrategies()` in `packages/core/src/registry.ts`.
3. Rebuild / restart. The strategy appears in the UI dropdown automatically.

Future ideas that fit the same pipeline:

- `milestone` — DOMContentLoaded + load
- `periodic` — every N seconds while a page is open

The timeline schema already includes `kind: 'navigation' | 'milestone' | 'periodic'`.

## Monorepo layout

```
apps/web          Vite + React UI
apps/server       Hono API + Playwright worker
packages/core     HAR indexer, strategies, shared types
data/             Local uploads and screenshots (gitignored)
```

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Liveness |
| GET | `/api/strategies` | Registered capture strategies |
| POST | `/api/jobs` | Multipart: `file`, optional `strategyId` |
| GET | `/api/jobs/:id` | Job status / progress |
| GET | `/api/jobs/:id/timeline` | Ordered capture results |
| GET | `/api/jobs/:id/screenshots/:captureId.png` | PNG |

## Limitations

- Best for multi-page / document navigations; SPAs that need clicks after load may look incomplete
- WebSockets, service workers, and requests missing from the HAR are aborted
- Playwright matches URL + method (+ POST body) strictly
- Zip HARs (Playwright archive format): extract to a `.har` first for v1

## Scripts

```bash
pnpm dev          # web + server
pnpm test         # core unit tests
pnpm build        # build all packages
```

Chromium is installed via Playwright on `pnpm install` (`postinstall`).
