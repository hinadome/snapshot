import type { CaptureStrategy } from '../strategy.js';
import type { CapturePoint, HarIndex } from '../types.js';

function slugId(index: number, url: string): string {
  let path = 'page';
  try {
    const u = new URL(url);
    path = u.pathname.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'root';
  } catch {
    path = 'page';
  }
  return `nav_${index}_${path}`.slice(0, 80);
}

/**
 * v1 strategy: one screenshot per navigated HTML document, ordered by time.
 */
export class DocumentNavigationStrategy implements CaptureStrategy {
  readonly id = 'document-navigation';
  readonly name = 'Document navigation';
  readonly description =
    'One screenshot per navigated HTML page, ordered by capture time.';

  plan(index: HarIndex): CapturePoint[] {
    return index.documents.map((doc, i) => ({
      id: slugId(i, doc.url),
      url: doc.url,
      atMs: doc.startedMs,
      label: doc.title,
      waitUntil: 'load' as const,
      kind: 'navigation' as const,
      pageref: doc.pageref,
    }));
  }
}

export const documentNavigationStrategy = new DocumentNavigationStrategy();
