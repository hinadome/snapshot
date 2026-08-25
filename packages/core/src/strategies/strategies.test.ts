import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  registerBuiltInStrategies,
  requireStrategy,
  buildHarIndex,
} from '../index.js';

const sampleHar = {
  log: {
    version: '1.2',
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
        request: { method: 'GET', url: 'https://example.com/' },
        response: {
          status: 200,
          content: { mimeType: 'text/html', text: '<html>Home</html>' },
        },
      },
    ],
  },
};

describe('page-timing strategy', () => {
  it('emits milestone stages per document', () => {
    registerBuiltInStrategies();
    const index = buildHarIndex(sampleHar);
    const plan = requireStrategy('page-timing').plan(index);
    assert.equal(plan.length, 5);
    assert.deepEqual(
      plan.map((p) => p.stage),
      ['commit', 'domcontentloaded', 'load', 'networkidle', 'fullpage'],
    );
    assert.ok(plan.every((p) => p.kind === 'milestone'));
  });
});

describe('scroll-viewport strategy', () => {
  it('emits load + scroll frames + fullpage', () => {
    registerBuiltInStrategies();
    const index = buildHarIndex(sampleHar);
    const plan = requireStrategy('scroll-viewport').plan(index);
    assert.ok(plan.length >= 3);
    assert.equal(plan[0]?.stage, 'load');
    assert.ok(plan.some((p) => p.stage === 'scroll' && p.kind === 'periodic'));
    assert.equal(plan[plan.length - 1]?.stage, 'fullpage');
  });
});
