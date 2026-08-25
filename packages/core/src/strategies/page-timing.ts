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

const STAGES = [
  'commit',
  'domcontentloaded',
  'load',
  'networkidle',
  'fullpage',
] as const;

/**
 * Progressive load milestones per navigated document.
 * Synthetic atMs = pageStart + stageIndex so timeline order is stable.
 */
export class PageTimingStrategy implements CaptureStrategy {
  readonly id = 'page-timing';
  readonly name = 'Page timings';
  readonly description =
    'Screenshots at commit, DOMContentLoaded, load, networkidle, and full page per navigation.';

  plan(index: HarIndex): CapturePoint[] {
    const points: CapturePoint[] = [];
    index.documents.forEach((doc, docIndex) => {
      const path = slugPath(doc.url);
      STAGES.forEach((stage, stageIndex) => {
        points.push({
          id: `pt_${docIndex}_${path}_${stage}`.slice(0, 80),
          url: doc.url,
          atMs: doc.startedMs + stageIndex,
          label: `${doc.title} · ${stage}`,
          waitUntil:
            stage === 'domcontentloaded'
              ? 'domcontentloaded'
              : stage === 'networkidle'
                ? 'networkidle'
                : 'load',
          kind: 'milestone',
          pageref: doc.pageref,
          stage,
          fullPage: stage === 'fullpage',
        });
      });
    });
    return points;
  }
}

export const pageTimingStrategy = new PageTimingStrategy();
