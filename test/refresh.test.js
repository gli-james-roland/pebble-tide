'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { shouldRefresh } = require('../src/pkjs/refresh');

test('shouldRefresh is true on first run (no prior fetch)', () => {
  assert.strictEqual(shouldRefresh('2026-06-07', 'kit', null), true);
});

test('shouldRefresh is true on a new calendar day', () => {
  assert.strictEqual(shouldRefresh('2026-06-08', 'kit', { date: '2026-06-07', stationId: 'kit' }), true);
});

test('shouldRefresh is true when the nearest station changed', () => {
  assert.strictEqual(shouldRefresh('2026-06-07', 'amb', { date: '2026-06-07', stationId: 'kit' }), true);
});

test('shouldRefresh is false on the same day at the same station', () => {
  assert.strictEqual(shouldRefresh('2026-06-07', 'kit', { date: '2026-06-07', stationId: 'kit' }), false);
});
