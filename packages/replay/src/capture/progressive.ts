import type { CapturePoint, CaptureResult } from '@snapshot/core';
import type { Page } from 'playwright';
import { attachHarRouter, loadHarRouteTable } from '../router/har-router.js';
import { getBrowser, DEFAULT_VIEWPORT } from './browser.js';
import { writeScreenshot } from './scroll.js';

function oneLine(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

function groupKey(point: CapturePoint): string {
  return `${point.pageref ?? ''}::${point.url}`;
}

/** Group consecutive capture points that share the same navigation URL. */
export function groupCapturePoints(points: CapturePoint[]): CapturePoint[][] {
  const groups: CapturePoint[][] = [];
  for (const point of points) {
    const key = groupKey(point);
    const last = groups[groups.length - 1];
    if (last && groupKey(last[0]!) === key) {
      last.push(point);
    } else {
      groups.push([point]);
    }
  }
  return groups;
}

async function snapForPoint(
  page: Page,
  point: CapturePoint,
  screenshotPath: string,
  sharedWarnings: string[],
): Promise<CaptureResult> {
  try {
    await writeScreenshot(page, screenshotPath, {
      fullPage: point.fullPage ?? point.stage === 'fullpage',
    });
    return {
      id: point.id,
      url: point.url,
      atMs: point.atMs,
      label: point.label,
      kind: point.kind,
      screenshotPath,
      warnings: [...sharedWarnings],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: point.id,
      url: point.url,
      atMs: point.atMs,
      label: point.label,
      kind: point.kind,
      screenshotPath,
      warnings: [...sharedWarnings],
      error: oneLine(message),
    };
  }
}

async function captureScrollPoint(
  page: Page,
  point: CapturePoint,
  screenshotPath: string,
  sharedWarnings: string[],
  step: number,
  maxY: number,
): Promise<CaptureResult> {
  const idx = point.scrollIndex ?? 0;
  const y = Math.min(idx * step, maxY);
  await page.evaluate((top) => window.scrollTo(0, top), y);
  await page.waitForTimeout(100);
  return snapForPoint(page, point, screenshotPath, sharedWarnings);
}

/**
 * Capture one navigation group in a single browser session.
 */
export async function captureNavigationGroup(
  harPath: string,
  points: CapturePoint[],
  getScreenshotPath: (captureId: string) => string,
  options: {
    harDir?: string;
    headless?: boolean;
  } = {},
): Promise<CaptureResult[]> {
  if (points.length === 0) return [];

  if (
    points.length === 1 &&
    (!points[0]!.stage || points[0]!.stage === 'fullpage') &&
    points[0]!.kind === 'navigation'
  ) {
    const { captureFromHar } = await import('./capture-point.js');
    return [
      await captureFromHar(harPath, points[0]!, {
        screenshotPath: getScreenshotPath(points[0]!.id),
        harDir: options.harDir,
        headless: options.headless,
      }),
    ];
  }

  const url = points[0]!.url;
  const warnings: string[] = [];
  const table = await loadHarRouteTable(harPath);
  table.harDir = options.harDir ?? table.harDir;

  const browser = await getBrowser(options.headless ?? true);
  const context = await browser.newContext({
    viewport: DEFAULT_VIEWPORT,
    deviceScaleFactor: 1,
    javaScriptEnabled: true,
    serviceWorkers: 'block',
    ignoreHTTPSErrors: true,
  });

  const results: CaptureResult[] = [];

  try {
    const failed: string[] = [];
    await attachHarRouter(context, table, (u, method) => {
      failed.push(`${method} ${u}`);
    });
    const page = await context.newPage();

    const byStage = (stage: NonNullable<CapturePoint['stage']>) =>
      points.filter((p) => p.stage === stage);

    try {
      if (byStage('commit').length > 0) {
        await page.goto(url, { waitUntil: 'commit', timeout: 45_000 });
        for (const point of byStage('commit')) {
          results.push(
            await snapForPoint(page, point, getScreenshotPath(point.id), warnings),
          );
        }
      } else {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 45_000,
        });
      }

      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 20_000 });
      } catch {
        /* continue */
      }
      for (const point of byStage('domcontentloaded')) {
        results.push(
          await snapForPoint(page, point, getScreenshotPath(point.id), warnings),
        );
      }

      try {
        await page.waitForLoadState('load', { timeout: 20_000 });
      } catch {
        /* continue */
      }
      await page.waitForTimeout(300);

      for (const point of [
        ...byStage('load'),
        ...points.filter(
          (p) => p.kind === 'navigation' && !p.stage && !p.fullPage,
        ),
      ]) {
        if (results.some((r) => r.id === point.id)) continue;
        results.push(
          await snapForPoint(page, point, getScreenshotPath(point.id), warnings),
        );
      }

      if (byStage('networkidle').length > 0) {
        try {
          await page.waitForLoadState('networkidle', { timeout: 10_000 });
        } catch {
          warnings.push('networkidle not reached; capturing current state');
        }
        for (const point of byStage('networkidle')) {
          results.push(
            await snapForPoint(page, point, getScreenshotPath(point.id), warnings),
          );
        }
      }

      const scrollPoints = byStage('scroll').sort(
        (a, b) => (a.scrollIndex ?? 0) - (b.scrollIndex ?? 0),
      );
      if (scrollPoints.length > 0) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(100);
        const metrics = await page.evaluate(() => ({
          scrollHeight: document.documentElement.scrollHeight,
          clientHeight: window.innerHeight,
        }));
        const step = Math.max(1, Math.floor(metrics.clientHeight * 0.85));
        const maxY = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
        const maxUseful =
          maxY === 0 ? 1 : Math.min(scrollPoints.length, Math.floor(maxY / step) + 1);

        for (const point of scrollPoints) {
          const idx = point.scrollIndex ?? 0;
          if (idx >= maxUseful) continue;
          results.push(
            await captureScrollPoint(
              page,
              point,
              getScreenshotPath(point.id),
              warnings,
              step,
              maxY,
            ),
          );
        }
        await page.evaluate(() => window.scrollTo(0, 0));
      }

      for (const point of byStage('fullpage')) {
        if (results.some((r) => r.id === point.id)) continue;
        results.push(
          await snapForPoint(
            page,
            { ...point, fullPage: true },
            getScreenshotPath(point.id),
            warnings,
          ),
        );
      }

      // Any remaining planned points (e.g. plain navigation with fullPage)
      for (const point of points) {
        if (results.some((r) => r.id === point.id)) continue;
        results.push(
          await snapForPoint(page, point, getScreenshotPath(point.id), warnings),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`Navigation issue: ${oneLine(message)}`);
      for (const point of points) {
        if (results.some((r) => r.id === point.id)) continue;
        results.push(
          await snapForPoint(page, point, getScreenshotPath(point.id), warnings),
        );
      }
    }

    if (failed.length > 0) {
      const sample = failed.slice(0, 5).join('; ');
      const miss = oneLine(
        `${failed.length} request(s) not served from HAR. e.g. ${sample}`,
      );
      for (const r of results) {
        r.warnings.push(miss);
      }
    }

    const byId = new Map(results.map((r) => [r.id, r]));
    return points
      .map((p) => byId.get(p.id))
      .filter((r): r is CaptureResult => Boolean(r));
  } finally {
    await context.close();
  }
}

export type PlanCaptureOptions = {
  harDir?: string;
  headless?: boolean;
  onProgress?: (
    current: number,
    total: number,
    label: string,
  ) => void | Promise<void>;
};

/**
 * Execute a full CapturePoint plan, grouping multi-stage navigations into one session.
 */
export async function executeCapturePlan(
  harPath: string,
  points: CapturePoint[],
  getScreenshotPath: (captureId: string) => string,
  options: PlanCaptureOptions = {},
): Promise<CaptureResult[]> {
  const groups = groupCapturePoints(points);
  const all: CaptureResult[] = [];
  let done = 0;
  const total = points.length;

  for (const group of groups) {
    await options.onProgress?.(
      done,
      total,
      group[0]?.label ?? group[0]?.url ?? 'capturing',
    );
    const results = await captureNavigationGroup(
      harPath,
      group,
      getScreenshotPath,
      options,
    );
    all.push(...results);
    done += group.length;
    await options.onProgress?.(done, total, `Captured ${done}/${total}`);
  }

  return all;
}
