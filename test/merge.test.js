'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { toCurvePoints, mergePoints } = require('../src/pkjs/tides');

test('toCurvePoints converts raw wlp samples to epoch + integer cm', () => {
  const pts = toCurvePoints([{ eventDate: '2026-06-07T00:00:00Z', value: 1.407 }]);
  assert.strictEqual(pts[0].epoch, Math.floor(Date.parse('2026-06-07T00:00:00Z') / 1000));
  assert.strictEqual(pts[0].heightCm, 141);
});

test('mergePoints merges curve + extrema into one time-sorted list with kinds', () => {
  const curve = [
    { epoch: 0, heightCm: 100 },
    { epoch: 20, heightCm: 300 },
  ];
  const extrema = [
    { epoch: 10, heightCm: 500, type: 'HIGH' },
    { epoch: 30, heightCm: 50, type: 'LOW' },
  ];
  const merged = mergePoints(curve, extrema);
  assert.deepStrictEqual(merged, [
    { epoch: 0, heightCm: 100, kind: 0 },  // plain
    { epoch: 10, heightCm: 500, kind: 1 }, // HIGH
    { epoch: 20, heightCm: 300, kind: 0 },
    { epoch: 30, heightCm: 50, kind: 2 },  // LOW
  ]);
});
