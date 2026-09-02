import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  corsResponseAllowed,
  crossOriginRequestNeedsCors,
  harEntryBlockedInCapture,
  isSameOriginUrl,
} from './cors.js';

describe('crossOriginRequestNeedsCors', () => {
  const page = 'https://app.example/page';

  it('skips same-origin requests', () => {
    assert.equal(
      crossOriginRequestNeedsCors({
        requestUrl: 'https://app.example/api',
        pageUrl: page,
        method: 'GET',
        resourceType: 'fetch',
        originHeader: 'https://app.example',
      }),
      false,
    );
  });

  it('requires CORS for cross-origin fetch', () => {
    assert.equal(
      crossOriginRequestNeedsCors({
        requestUrl: 'https://api.other/data',
        pageUrl: page,
        method: 'GET',
        resourceType: 'fetch',
        originHeader: 'https://app.example',
        secFetchMode: 'cors',
      }),
      true,
    );
  });

  it('allows classic cross-origin script without Origin', () => {
    assert.equal(
      crossOriginRequestNeedsCors({
        requestUrl: 'https://cdn.other/app.js',
        pageUrl: page,
        method: 'GET',
        resourceType: 'script',
      }),
      false,
    );
  });

  it('requires CORS for crossorigin script (Origin present)', () => {
    assert.equal(
      crossOriginRequestNeedsCors({
        requestUrl: 'https://cdn.other/app.mjs',
        pageUrl: page,
        method: 'GET',
        resourceType: 'script',
        originHeader: 'https://app.example',
      }),
      true,
    );
  });
});

describe('corsResponseAllowed', () => {
  it('denies when ACAO missing', () => {
    assert.equal(
      corsResponseAllowed('https://app.example', 'GET', { 'Content-Type': 'application/json' }),
      false,
    );
  });

  it('allows matching ACAO', () => {
    assert.equal(
      corsResponseAllowed('https://app.example', 'GET', {
        'Access-Control-Allow-Origin': 'https://app.example',
      }),
      true,
    );
  });

  it('denies wildcard with credentials', () => {
    assert.equal(
      corsResponseAllowed(
        'https://app.example',
        'GET',
        { 'Access-Control-Allow-Origin': '*' },
        true,
      ),
      false,
    );
  });

  it('requires allow-methods on OPTIONS', () => {
    assert.equal(
      corsResponseAllowed('https://app.example', 'OPTIONS', {
        'Access-Control-Allow-Origin': 'https://app.example',
      }),
      false,
    );
  });
});

describe('harEntryBlockedInCapture', () => {
  it('treats status 0 as blocked', () => {
    assert.equal(harEntryBlockedInCapture({ response: { status: 0 } }), true);
  });

  it('treats cors failure text as blocked', () => {
    assert.equal(
      harEntryBlockedInCapture({
        response: { status: 200 },
        _failureText: 'net::ERR_BLOCKED_BY_CORS',
      }),
      true,
    );
  });
});

describe('isSameOriginUrl', () => {
  it('matches origin ignoring path', () => {
    assert.equal(
      isSameOriginUrl('https://a.com/x', 'https://a.com/y'),
      true,
    );
    assert.equal(
      isSameOriginUrl('https://a.com', 'https://b.com'),
      false,
    );
  });
});
