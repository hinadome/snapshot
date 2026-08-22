import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildHarIndex, parseHarJson } from './har-index.js';
import {
  registerBuiltInStrategies,
  requireStrategy,
} from './registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, '../fixtures/sample.har.json');
describe('buildHarIndex', () => {
  it('indexes pages and document navigations', () => {
    const raw = parseHarJson(readFileSync(fixturePath, 'utf8'));
    const index = buildHarIndex(raw);

    assert.equal(index.stats.entryCount, 3);
    assert.equal(index.stats.pageCount, 2);
    assert.equal(index.stats.documentCount, 2);
    assert.equal(index.documents[0]?.url, 'https://example.com/');
    assert.equal(index.documents[1]?.url, 'https://example.com/about');
    assert.equal(index.documents[0]?.startedMs, 0);
    assert.equal(index.documents[1]?.startedMs, 5000);
    assert.ok(index.stats.bodyCoveragePct > 90);
  });

  it('rejects empty entries', () => {
    assert.throws(
      () => buildHarIndex({ log: { version: '1.2', entries: [] } }),
      /empty/,
    );
  });
});

describe('DocumentNavigationStrategy', () => {
  it('plans one capture point per document', () => {
    registerBuiltInStrategies();
    const raw = parseHarJson(readFileSync(fixturePath, 'utf8'));
    const index = buildHarIndex(raw);
    const strategy = requireStrategy('document-navigation');
    const plan = strategy.plan(index);

    assert.equal(plan.length, 2);
    assert.equal(plan[0]?.kind, 'navigation');
    assert.equal(plan[0]?.waitUntil, 'load');
    assert.equal(plan[1]?.url, 'https://example.com/about');
    assert.ok(plan[0]?.id.startsWith('nav_0_'));
  });
});
