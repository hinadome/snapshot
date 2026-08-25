import { chromium, type Browser } from 'playwright';

let browserPromise: Promise<Browser> | null = null;

export async function getBrowser(headless = true): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless });
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

export const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
