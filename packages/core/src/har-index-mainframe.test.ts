import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildHarIndex } from './har-index.js';

describe('buildHarIndex main-frame documents', () => {
  it('keeps only the first main document per pageref (not iframes)', () => {
    const har = {
      log: {
        version: '1.2',
        pages: [
          {
            id: 'page_1',
            title: 'Shop',
            startedDateTime: '2024-01-01T10:00:00.000Z',
          },
        ],
        entries: [
          {
            pageref: 'page_1',
            startedDateTime: '2024-01-01T10:00:00.000Z',
            _resourceType: 'document',
            request: { method: 'GET', url: 'https://shop.example.com/' },
            response: {
              status: 200,
              content: {
                mimeType: 'text/html',
                text: '<html>main</html>',
              },
            },
          },
          {
            pageref: 'page_1',
            startedDateTime: '2024-01-01T10:00:01.000Z',
            _resourceType: 'document',
            request: {
              method: 'GET',
              url: 'https://ads.example.com/iframe',
            },
            response: {
              status: 200,
              content: {
                mimeType: 'text/html',
                text: '<html>ad</html>',
              },
            },
          },
          {
            pageref: 'page_1',
            startedDateTime: '2024-01-01T10:00:02.000Z',
            _resourceType: 'document',
            request: {
              method: 'GET',
              url: 'https://tracker.example.com/pixel',
            },
            response: {
              status: 200,
              content: {
                mimeType: 'text/html',
                text: '<html>pixel</html>',
              },
            },
          },
        ],
      },
    };

    const index = buildHarIndex(har);
    assert.equal(index.documents.length, 1);
    assert.equal(index.documents[0]?.url, 'https://shop.example.com/');
  });
});
