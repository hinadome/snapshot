import type { CaptureStrategy } from '../strategy.js';
import type { CapturePoint, HarIndex } from '../types.js';

function slugPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'root';
  } catch {
    return 'page';
  }
}

const DEFAULT_MAX_SCROLL_FRAMES = 12;

/**
 * Viewport screenshots while scrolling each navigated page, then a full-page shot.
 * Extra scroll frames beyond page height are skipped at capture time.
 */
export class ScrollViewportStrategy implements CaptureStrategy {
  readonly id = 'scroll-viewport';
  readonly name = 'Scroll viewport';
  readonly description =
    'Viewport frames while scrolling each page, plus a final full-page screenshot.';

  constructor(private readonly maxScrollFrames = DEFAULT_MAX_SCROLL_FRAMES) {}

  plan(index: HarIndex): CapturePoint[] {
    const points: CapturePoint[] = [];
    index.documents.forEach((doc, docIndex) => {
      const path = slugPath(doc.url);
      let offset = 0;

      points.push({
        id: `sv_${docIndex}_${path}_load`.slice(0, 80),
        url: doc.url,
        atMs: doc.startedMs + offset++,
        label: `${doc.title} · load`,
        waitUntil: 'load',
        kind: 'navigation',
        pageref: doc.pageref,
        stage: 'load',
        fullPage: false,
      });

      for (let i = 0; i < this.maxScrollFrames; i++) {
        points.push({
          id: `sv_${docIndex}_${path}_scroll_${i}`.slice(0, 80),
          url: doc.url,
          atMs: doc.startedMs + offset++,
          label: `${doc.title} · scroll ${i + 1}`,
          waitUntil: 'load',
          kind: 'periodic',
          pageref: doc.pageref,
          stage: 'scroll',
          scrollIndex: i,
          fullPage: false,
        });
      }

      points.push({
        id: `sv_${docIndex}_${path}_fullpage`.slice(0, 80),
        url: doc.url,
        atMs: doc.startedMs + offset++,
        label: `${doc.title} · fullpage`,
        waitUntil: 'load',
        kind: 'milestone',
        pageref: doc.pageref,
        stage: 'fullpage',
        fullPage: true,
      });
    });
    return points;
  }
}

export const scrollViewportStrategy = new ScrollViewportStrategy();
