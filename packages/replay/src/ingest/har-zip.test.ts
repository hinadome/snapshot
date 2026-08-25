import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { zipSync } from 'fflate';
import {
  extractHarZipToDir,
  openInputBuffer,
  persistNormalizedHar,
} from './open-input.js';
import { bodyFromHarEntry } from '../router/har-router.js';

describe('Playwright HAR zip with _file sidecars', () => {
  it('extracts har.har and body files into the same directory', () => {
    const htmlBody = Buffer.from('<html><body>zip-home</body></html>', 'utf8');
    const bodyName = 'a1b2c3d4e5';
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'Playwright', version: '1.0' },
        pages: [
          {
            id: 'page_0',
            title: 'Home',
            startedDateTime: '2024-01-01T10:00:00.000Z',
          },
        ],
        entries: [
          {
            pageref: 'page_0',
            startedDateTime: '2024-01-01T10:00:00.000Z',
            _resourceType: 'document',
            request: {
              method: 'GET',
              url: 'https://example.com/',
              headers: [{ name: 'Accept', value: 'text/html' }],
            },
            response: {
              status: 200,
              headers: [],
              content: {
                size: htmlBody.length,
                mimeType: 'text/html',
                _file: bodyName,
              },
            },
          },
        ],
      },
    };

    const zipped = zipSync({
      'har.har': Buffer.from(JSON.stringify(har), 'utf8'),
      [bodyName]: htmlBody,
    });

    const dir = mkdtempSync(join(tmpdir(), 'snapshot-zip-test-'));
    try {
      const harPath = extractHarZipToDir(Buffer.from(zipped), dir);
      assert.ok(existsSync(harPath));
      assert.ok(existsSync(join(dir, 'har.har')));
      assert.ok(existsSync(join(dir, bodyName)));
      assert.ok(existsSync(join(dir, 'capture.har')));

      const parsed = JSON.parse(readFileSync(harPath, 'utf8'));
      const entry = parsed.log.entries[0];
      const body = bodyFromHarEntry(entry, dir);
      assert.equal(String(body), '<html><body>zip-home</body></html>');

      const dest = mkdtempSync(join(tmpdir(), 'snapshot-persist-'));
      try {
        const input = openInputBuffer(Buffer.from(zipped), 'export.har.zip');
        try {
          persistNormalizedHar(input, join(dest, 'capture.har'));
          assert.ok(existsSync(join(dest, 'capture.har')));
          assert.ok(existsSync(join(dest, bodyName)));
        } finally {
          input.cleanup?.();
        }
      } finally {
        rmSync(dest, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
