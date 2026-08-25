import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findHarEntry, type HarRouteTable } from '../router/har-router.js';

const table: HarRouteTable = {
  entries: [
    {
      request: {
        method: 'GET',
        url: 'https://example.com/ns?c=aaa',
      },
      response: {
        status: 200,
        content: { mimeType: 'text/html', text: '<html>a</html>' },
      },
    },
    {
      request: {
        method: 'GET',
        url: 'https://example.com/ns?c=bbb',
      },
      response: {
        status: 200,
        content: { mimeType: 'text/html', text: '<html>b</html>' },
      },
    },
    {
      request: {
        method: 'GET',
        url: 'https://cdn.example.com/app.js?v=1',
      },
      response: {
        status: 200,
        content: { mimeType: 'application/javascript', text: 'console.log(1)' },
      },
    },
  ],
};

describe('findHarEntry', () => {
  it('matches exact URL', () => {
    const hit = findHarEntry(table, 'GET', 'https://example.com/ns?c=bbb');
    assert.equal(hit?.response?.content?.text, '<html>b</html>');
  });

  it('falls back to pathname match for GET when query differs', () => {
    const hit = findHarEntry(table, 'GET', 'https://example.com/ns?c=zzz-new');
    assert.ok(hit?.response?.content?.text?.includes('<html>'));
  });

  it('matches pathname for static assets', () => {
    const hit = findHarEntry(
      table,
      'GET',
      'https://cdn.example.com/app.js?v=999',
    );
    assert.equal(hit?.response?.content?.text, 'console.log(1)');
  });
});
