import type { CapturePoint, CaptureResult } from '@snapshot/core';
import { attachHarRouter, loadHarRouteTable } from '../router/har-router.js';
import { getBrowser, DEFAULT_VIEWPORT } from './browser.js';

export type CaptureOptions = {
  screenshotPath: string;
  harDir?: string;
  headless?: boolean;
  offline?: boolean;
};

function oneLine(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

async function waitForRender(page: import('playwright').Page): Promise<void> {
  try {
    await page.waitForLoadState('load', { timeout: 20_000 });
  } catch {
    // DOM may still be usable
  }
  try {
    await page.waitForLoadState('networkidle', { timeout: 10_000 });
  } catch {
    // SPAs often never reach networkidle
  }
  await page.waitForTimeout(500);
}

export async function captureFromHar(
  harPath: string,
  point: CapturePoint,
  options: CaptureOptions,
): Promise<CaptureResult> {
  const warnings: string[] = [];
  const outPath = options.screenshotPath;
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

  try {
    const failed: string[] = [];
    await attachHarRouter(context, table, (url, method) => {
      failed.push(`${method} ${url}`);
    });

    const page = await context.newPage();

    try {
      await page.goto(point.url, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      await waitForRender(page);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`Navigation issue: ${oneLine(message)}`);
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 5_000 });
        await waitForRender(page);
      } catch {
        // screenshot whatever rendered
      }
    }

    if (failed.length > 0) {
      const sample = failed.slice(0, 5).join('; ');
      warnings.push(
        `${failed.length} request(s) not served from HAR. Missing assets, dynamic URLs (tokens), or WebSockets often cause incomplete pages. e.g. ${sample}`,
      );
    }

    await page.screenshot({
      path: outPath,
      fullPage: point.fullPage ?? true,
      type: 'png',
      animations: 'disabled',
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
