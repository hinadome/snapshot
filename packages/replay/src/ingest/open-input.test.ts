import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectHarData, describeHarSource } from '../inspect/har-info.js';
import { openInputPath } from './open-input.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = join(
  __dirname,
  '../../../core/fixtures/sample.har.json',
);

describe('inspectHarData', () => {
  it('detects entries and body coverage', () => {
    const data = JSON.parse(readFileSync(fixture, 'utf8'));
    const info = inspectHarData(data);
    assert.equal(info.entryCount, 3);
    assert.equal(info.hasDocument, true);
    assert.ok(info.bodyCoveragePct >= 90);
    assert.match(describeHarSource(info), /HAR/);
  });
});

describe('openInputPath', () => {
  it('opens a plain .har file', () => {
    const input = openInputPath(fixture);
    try {
      assert.equal(input.kind, 'har');
      assert.equal(input.sourceInfo.entryCount, 3);
    } finally {
      input.cleanup?.();
    }
  });
});
