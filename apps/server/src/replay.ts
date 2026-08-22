import { chromium, type Browser } from 'playwright';
import type { CapturePoint, CaptureResult } from '@snapshot/core';
import { attachHarRouter, loadHarRouteTable } from './har-router.js';
import { harPath, screenshotFile } from './paths.js';

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    const b = await browserPromise;
    browserPromise = null;
    await b.close();
  }
}

function oneLine(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

/**
 * Replay a single capture point by serving network from the HAR file.
 */
export async function capturePointFromHar(
  jobId: string,
  point: CapturePoint,
): Promise<CaptureResult> {
  const warnings: string[] = [];
  const outPath = screenshotFile(jobId, point.id);
  const table = await loadHarRouteTable(harPath(jobId));
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    javaScriptEnabled: true,
    serviceWorkers: 'block',
    ignoreHTTPSErrors: true,
  });

  try {
    const failed: string[] = [];
    await attachHarRouter(context, table, (url, method) => {
      failed.push(`${method} ${url}`);
    });

    const page = await context.newPage();

    try {
      await page.goto(point.url, {
        waitUntil: point.waitUntil,
        timeout: 45_000,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`Navigation issue: ${oneLine(message)}`);
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 5_000 });
      } catch {
        // ignore — screenshot whatever we have
      }
    }

    if (failed.length > 0) {
      const sample = failed.slice(0, 3).join('; ');
      warnings.push(
        `${failed.length} request(s) not found in HAR (aborted). e.g. ${sample}`,
      );
    }

    await page.screenshot({
      path: outPath,
      fullPage: true,
      type: 'png',
    });

    return {
      id: point.id,
      url: point.url,
      atMs: point.atMs,
      label: point.label,
      kind: point.kind,
      screenshotPath: outPath,
      warnings: warnings.map(oneLine),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: point.id,
      url: point.url,
      atMs: point.atMs,
      label: point.label,
      kind: point.kind,
      screenshotPath: outPath,
      warnings: warnings.map(oneLine),
      error: oneLine(message),
    };
  } finally {
    await context.close();
  }
}
