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

// --- Region window staleness (#61) -----------------------------------------
// regionNeedsRefresh(fetchedAt, todayStr, rangeDays, minDaysRemaining=30):
// stale when (rangeDays - ageInDays) <= minDaysRemaining. Null fetchedAt = stale.

const { regionNeedsRefresh } = require('../src/pkjs/refresh');

test('regionNeedsRefresh is false for a fresh region (just fetched)', () => {
  // 45-day window, fetched today -> 45 days remaining > 30 threshold.
  assert.strictEqual(regionNeedsRefresh('2026-06-13', '2026-06-13', 45, 30), false);
});

test('regionNeedsRefresh is false just inside the threshold', () => {
  // age 14 -> 31 remaining > 30: still fresh.
  assert.strictEqual(regionNeedsRefresh('2026-05-30', '2026-06-13', 45, 30), false);
});

test('regionNeedsRefresh is true at the threshold boundary', () => {
  // age 15 -> 30 remaining <= 30: stale.
  assert.strictEqual(regionNeedsRefresh('2026-05-29', '2026-06-13', 45, 30), true);
});

test('regionNeedsRefresh is true for an aged region', () => {
  // age 40 -> 5 remaining: stale.
  assert.strictEqual(regionNeedsRefresh('2026-05-04', '2026-06-13', 45, 30), true);
});

test('regionNeedsRefresh treats a null fetchedAt as stale', () => {
  assert.strictEqual(regionNeedsRefresh(null, '2026-06-13', 45, 30), true);
});

test('regionNeedsRefresh defaults minDaysRemaining to 30', () => {
  // age 15 -> 30 remaining <= default 30: stale, no fourth arg.
  assert.strictEqual(regionNeedsRefresh('2026-05-29', '2026-06-13', 45), true);
  // age 14 -> 31 remaining: fresh.
  assert.strictEqual(regionNeedsRefresh('2026-05-30', '2026-06-13', 45), false);
});
