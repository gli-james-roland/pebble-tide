'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyExtrema, pickNextExtremum } = require('../src/pkjs/tides');

test('classifyExtrema labels an alternating series HIGH/LOW by neighbor comparison', () => {
  const extrema = [
    { eventDate: '2026-06-07T06:47:00Z', value: 4.494 },
    { eventDate: '2026-06-07T13:31:00Z', value: 2.939 },
    { eventDate: '2026-06-07T16:58:00Z', value: 3.176 },
    { eventDate: '2026-06-07T23:44:00Z', value: 1.670 },
  ];
  const types = classifyExtrema(extrema).map((e) => e.type);
  assert.deepStrictEqual(types, ['HIGH', 'LOW', 'HIGH', 'LOW']);
});

test('classifyExtrema classifies the first element by looking forward', () => {
  const extrema = [
    { eventDate: '2026-06-07T00:38:00Z', value: 2.060 },
    { eventDate: '2026-06-07T07:50:00Z', value: 4.424 },
    { eventDate: '2026-06-07T14:58:00Z', value: 2.168 },
  ];
  const types = classifyExtrema(extrema).map((e) => e.type);
  assert.deepStrictEqual(types, ['LOW', 'HIGH', 'LOW']);
});

test('classifyExtrema converts eventDate to unix epoch seconds and metres to integer cm', () => {
  const [first] = classifyExtrema([
    { eventDate: '2026-06-07T06:47:00Z', value: 4.494 },
    { eventDate: '2026-06-07T13:31:00Z', value: 2.939 },
  ]);
  assert.strictEqual(first.epoch, Math.floor(Date.parse('2026-06-07T06:47:00Z') / 1000));
  assert.strictEqual(first.heightCm, 449);
});

test('pickNextExtremum returns the first extremum at or after now', () => {
  const classified = classifyExtrema([
    { eventDate: '2026-06-07T06:47:00Z', value: 4.494 },
    { eventDate: '2026-06-07T13:31:00Z', value: 2.939 },
    { eventDate: '2026-06-07T16:58:00Z', value: 3.176 },
  ]);
  const now = Math.floor(Date.parse('2026-06-07T10:00:00Z') / 1000);
  const next = pickNextExtremum(classified, now);
  assert.strictEqual(next.epoch, Math.floor(Date.parse('2026-06-07T13:31:00Z') / 1000));
  assert.strictEqual(next.type, 'LOW');
});

test('pickNextExtremum returns null when every extremum is in the past', () => {
  const classified = classifyExtrema([
    { eventDate: '2026-06-07T06:47:00Z', value: 4.494 },
    { eventDate: '2026-06-07T13:31:00Z', value: 2.939 },
  ]);
  const now = Math.floor(Date.parse('2026-06-08T00:00:00Z') / 1000);
  assert.strictEqual(pickNextExtremum(classified, now), null);
});
