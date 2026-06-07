'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { shouldRefresh } = require('../src/pkjs/refresh');

const V = 2; // current blob version

test('shouldRefresh is true on first run (no prior fetch)', () => {
  assert.strictEqual(shouldRefresh('2026-06-07', 'kit', V, null), true);
});

test('shouldRefresh is true on a new calendar day', () => {
  assert.strictEqual(shouldRefresh('2026-06-08', 'kit', V, { date: '2026-06-07', stationId: 'kit', version: V }), true);
});

test('shouldRefresh is true when the nearest station changed', () => {
  assert.strictEqual(shouldRefresh('2026-06-07', 'amb', V, { date: '2026-06-07', stationId: 'kit', version: V }), true);
});

test('shouldRefresh is true when the blob version changed (app update)', () => {
  assert.strictEqual(shouldRefresh('2026-06-07', 'kit', V, { date: '2026-06-07', stationId: 'kit', version: 1 }), true);
});

test('shouldRefresh is false on the same day, same station, same version', () => {
  assert.strictEqual(shouldRefresh('2026-06-07', 'kit', V, { date: '2026-06-07', stationId: 'kit', version: V }), false);
});
