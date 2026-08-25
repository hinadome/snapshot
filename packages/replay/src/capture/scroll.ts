import type { Page } from 'playwright';
import { join } from 'node:path';

function padIndex(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

export async function writeScreenshot(
  page: Page,
  outPath: string,
  opts: { fullPage?: boolean } = {},
): Promise<string> {
  await page.screenshot({
    path: outPath,
    fullPage: Boolean(opts.fullPage),
    animations: 'disabled',
    type: 'png',
  });
  return outPath;
}

/**
 * Capture viewport frames while scrolling the page.
 */
export async function captureScrollFrames(
  page: Page,
  options: {
    outDir: string;
    idPrefix: string;
    maxFrames?: number;
    overlap?: number;
    startIndex?: number;
  },
): Promise<{ paths: string[]; nextIndex: number; frameCount: number }> {
  const overlap = options.overlap ?? 0.15;
  const maxFrames = options.maxFrames ?? 20;
  let index = options.startIndex ?? 0;
  const paths: string[] = [];

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);

  const metrics = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: window.innerHeight,
  }));

  const step = Math.max(1, Math.floor(metrics.clientHeight * (1 - overlap)));
  let y = 0;
  let frame = 0;

  while (frame < maxFrames) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(100);
    const outPath = join(
      options.outDir,
      `${options.idPrefix}_scroll_${padIndex(frame)}.png`,
    );
    paths.push(await writeScreenshot(page, outPath));
    index += 1;
    frame += 1;
    if (y + metrics.clientHeight >= metrics.scrollHeight - 1) break;
    y = Math.min(y + step, Math.max(0, metrics.scrollHeight - metrics.clientHeight));
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  return { paths, nextIndex: index, frameCount: frame };
}
