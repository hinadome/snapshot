import type { CapturePoint, CaptureResult } from '@snapshot/core';
import { attachHarRouter, loadHarRouteTable } from '../router/har-router.js';
import { getBrowser, DEFAULT_VIEWPORT } from './browser.js';

export type CaptureOptions = {
  screenshotPath: string;
  harDir?: string;
  headless?: boolean;
  offline?: boolean;
  /** When false, replay all HAR responses without CORS enforcement. Default true. */
  enforceCors?: boolean;
};

function oneLine(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

/** Summary + one request per line (avoids a single giant unbroken string in the UI). */
export function formatRequestListWarning(
  summary: string,
  requests: string[],
): string {
  if (requests.length === 0) return summary;
  return `${summary}\n${requests.join('\n')}`;
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
    const harMisses: string[] = [];
    const corsBlocks: string[] = [];
    await attachHarRouter(context, table, {
      enforceCors: options.enforceCors,
      onMiss: (u, m) => harMisses.push(`${m} ${u}`),
      onCorsBlock: (u, m) => corsBlocks.push(`${m} ${u}`),
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

    if (corsBlocks.length > 0) {
      warnings.push(
        formatRequestListWarning(
          `${corsBlocks.length} cross-origin request(s) blocked by CORS during replay (matching browser behavior)`,
          corsBlocks,
        ),
      );
    }

    if (harMisses.length > 0) {
      warnings.push(
        formatRequestListWarning(
          `${harMisses.length} request(s) not served from HAR. Missing assets, dynamic URLs (tokens), or WebSockets often cause incomplete pages`,
          harMisses,
        ),
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
      warnings,
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
      warnings,
      error: oneLine(message),
    };
  } finally {
    await context.close();
  }
}
