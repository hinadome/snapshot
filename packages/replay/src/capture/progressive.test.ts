import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { groupCapturePoints } from './progressive.js';
import type { CapturePoint } from '@snapshot/core';

function pt(
  partial: Partial<CapturePoint> & Pick<CapturePoint, 'id' | 'url'>,
): CapturePoint {
  return {
    atMs: 0,
    label: partial.id,
    waitUntil: 'load',
    kind: 'milestone',
    ...partial,
  };
}

describe('groupCapturePoints', () => {
  it('groups consecutive points with the same URL', () => {
    const points = [
      pt({ id: 'a1', url: 'https://a.com/', stage: 'commit' }),
      pt({ id: 'a2', url: 'https://a.com/', stage: 'load' }),
      pt({ id: 'b1', url: 'https://b.com/', stage: 'load' }),
    ];
    const groups = groupCapturePoints(points);
    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.length, 2);
    assert.equal(groups[1]?.length, 1);
  });
});
