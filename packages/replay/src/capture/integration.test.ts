import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildHarIndex,
  parseHarJson,
  registerBuiltInStrategies,
  requireStrategy,
} from '@snapshot/core';
import {
  closeBrowser,
  executeCapturePlan,
  openInputPath,
} from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = join(__dirname, '../../../core/fixtures/sample.har.json');
const outDir = join(__dirname, '../../.tmp-integration');

describe('integration: capture sample HAR', () => {
  after(async () => {
    await closeBrowser();
    rmSync(outDir, { recursive: true, force: true });
  });

  it('produces PNG screenshots for document-navigation', async () => {
    registerBuiltInStrategies();
    mkdirSync(outDir, { recursive: true });

    const input = openInputPath(fixture);
    try {
      const index = buildHarIndex(
        parseHarJson(readFileSync(input.harPath, 'utf8')),
      );
      const points = requireStrategy('document-navigation').plan(index);
      assert.equal(points.length, 2);

      const results = await executeCapturePlan(
        input.harPath,
        points,
        (id) => join(outDir, `${id}.png`),
        { harDir: input.harDir, headless: true },
      );

      assert.equal(results.length, 2);
      for (const r of results) {
        assert.ok(!r.error, r.error);
        const st = statSync(r.screenshotPath);
        assert.ok(st.size > 500, `screenshot too small: ${r.screenshotPath}`);
        const magic = readFileSync(r.screenshotPath).subarray(0, 8);
        assert.equal(magic[0], 0x89);
        assert.equal(magic[1], 0x50); // PNG
      }
    } finally {
      input.cleanup?.();
    }
  });
});
