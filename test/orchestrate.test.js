'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const orchestrate = require('../src/pkjs/orchestrate');

const DAY_MS = 24 * 60 * 60 * 1000;
const TTL = orchestrate.CATALOG_TTL_MS;
const V = 3; // current catalog/blob version

test('CATALOG_TTL_MS is 30 days', () => {
  assert.strictEqual(orchestrate.CATALOG_TTL_MS, 30 * 24 * 60 * 60 * 1000);
});

// --- hasAnyCache ---

test('hasAnyCache: empty cache is false', () => {
  assert.strictEqual(orchestrate.hasAnyCache({}), false);
});

test('hasAnyCache: a slice with an empty stations array is false', () => {
  assert.strictEqual(orchestrate.hasAnyCache({ noaa: { stations: [], fetchedAt: 1 } }), false);
});

test('hasAnyCache: a slice with at least one station is true', () => {
  assert.strictEqual(
    orchestrate.hasAnyCache({ noaa: { stations: [{ id: 'n1' }], fetchedAt: 1 } }),
    true
  );
});

test('hasAnyCache: one empty + one non-empty slice is true', () => {
  const cache = {
    dfo: { stations: [], fetchedAt: 1 },
    noaa: { stations: [{ id: 'n1' }], fetchedAt: 1 },
  };
  assert.strictEqual(orchestrate.hasAnyCache(cache), true);
});

// --- sliceNeedsRefresh ---

test('sliceNeedsRefresh: an absent slice needs refresh', () => {
  assert.strictEqual(orchestrate.sliceNeedsRefresh(undefined, 1000 * DAY_MS, TTL, V), true);
});

test('sliceNeedsRefresh: a slice fetched 29 days ago does not need refresh', () => {
  const now = 1000 * DAY_MS;
  const slice = { stations: [{ id: 'n1' }], fetchedAt: now - 29 * DAY_MS, version: V };
  assert.strictEqual(orchestrate.sliceNeedsRefresh(slice, now, TTL, V), false);
});

test('sliceNeedsRefresh: a slice fetched 31 days ago needs refresh (TTL)', () => {
  const now = 1000 * DAY_MS;
  const slice = { stations: [{ id: 'n1' }], fetchedAt: now - 31 * DAY_MS, version: V };
  assert.strictEqual(orchestrate.sliceNeedsRefresh(slice, now, TTL, V), true);
});

test('sliceNeedsRefresh: a recent slice with a mismatched version needs refresh', () => {
  const now = 1000 * DAY_MS;
  const slice = { stations: [{ id: 'n1' }], fetchedAt: now - 1 * DAY_MS, version: V - 1 };
  assert.strictEqual(orchestrate.sliceNeedsRefresh(slice, now, TTL, V), true);
});

test('sliceNeedsRefresh: a recent slice with a missing version needs refresh', () => {
  const now = 1000 * DAY_MS;
  const slice = { stations: [{ id: 'n1' }], fetchedAt: now - 1 * DAY_MS };
  assert.strictEqual(orchestrate.sliceNeedsRefresh(slice, now, TTL, V), true);
});

test('sliceNeedsRefresh: a recent slice with a matching version does not need refresh', () => {
  const now = 1000 * DAY_MS;
  const slice = { stations: [{ id: 'n1' }], fetchedAt: now - 1 * DAY_MS, version: V };
  assert.strictEqual(orchestrate.sliceNeedsRefresh(slice, now, TTL, V), false);
});

// --- providersToRefresh ---

test('providersToRefresh: fresh noaa + stale dfo -> [dfo]', () => {
  const now = 1000 * DAY_MS;
  const cache = {
    noaa: { stations: [{ id: 'n1' }], fetchedAt: now - 1 * DAY_MS, version: V },
    dfo: { stations: [{ id: 'd1' }], fetchedAt: now - 40 * DAY_MS, version: V },
  };
  assert.deepStrictEqual(
    orchestrate.providersToRefresh(cache, now, TTL, V, ['dfo', 'noaa']),
    ['dfo']
  );
});

test('providersToRefresh: both fresh -> []', () => {
  const now = 1000 * DAY_MS;
  const cache = {
    noaa: { stations: [{ id: 'n1' }], fetchedAt: now - 1 * DAY_MS, version: V },
    dfo: { stations: [{ id: 'd1' }], fetchedAt: now - 1 * DAY_MS, version: V },
  };
  assert.deepStrictEqual(
    orchestrate.providersToRefresh(cache, now, TTL, V, ['dfo', 'noaa']),
    []
  );
});

test('providersToRefresh: empty cache -> all provider names', () => {
  const now = 1000 * DAY_MS;
  assert.deepStrictEqual(
    orchestrate.providersToRefresh({}, now, TTL, V, ['dfo', 'noaa']),
    ['dfo', 'noaa']
  );
});

// --- mergeRefreshResults (per-provider failure isolation) ---

test('mergeRefreshResults: a failed dfo fetch keeps the old dfo slice while noaa updates', () => {
  const oldCache = {
    dfo: { stations: [{ id: 'd-old' }], fetchedAt: 1, version: V },
    noaa: { stations: [{ id: 'n-old' }], fetchedAt: 1, version: V },
  };
  const results = {
    dfo: { ok: false },
    noaa: { ok: true, stations: [{ id: 'n-new' }], fetchedAt: 5000, version: V },
  };
  const merged = orchestrate.mergeRefreshResults(oldCache, results);
  // dfo retains its last-good slice unchanged
  assert.deepStrictEqual(merged.dfo, { stations: [{ id: 'd-old' }], fetchedAt: 1, version: V });
  // noaa replaced with the fresh slice
  assert.deepStrictEqual(merged.noaa, { stations: [{ id: 'n-new' }], fetchedAt: 5000, version: V });
});

test('mergeRefreshResults: a successful fetch for an absent provider adds the slice', () => {
  const merged = orchestrate.mergeRefreshResults(
    {},
    { noaa: { ok: true, stations: [{ id: 'n1' }], fetchedAt: 7, version: V } }
  );
  assert.deepStrictEqual(merged.noaa, { stations: [{ id: 'n1' }], fetchedAt: 7, version: V });
});

test('mergeRefreshResults: a failed fetch for an absent provider leaves it absent', () => {
  const merged = orchestrate.mergeRefreshResults({}, { dfo: { ok: false } });
  assert.strictEqual(merged.dfo, undefined);
});
