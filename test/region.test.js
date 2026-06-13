'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const region = require('../src/pkjs/region');

function fakeStorage() {
  const m = {};
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
  };
}

test('read returns auto mode when nothing stored', () => {
  assert.deepStrictEqual(region.read(fakeStorage()), { mode: 'auto' });
});

test('write then read round-trips a region record', () => {
  const s = fakeStorage();
  const rec = {
    mode: 'region', place: 'Desolation Sound', center: { lat: 50.1, lon: -124.7 },
    radiusKm: 150, cap: 400, stations: [{ id: 'A' }, { id: 'B' }],
    fetchedAt: '2026-06-13', rangeDays: 45, truncated: false, error: null,
  };
  region.write(s, rec);
  assert.deepStrictEqual(region.read(s), rec);
});

test('read returns auto when a non-region record is stored', () => {
  const s = fakeStorage();
  s.setItem(region.STORE_KEY, JSON.stringify({ mode: 'pinned', place: 'X' }));
  assert.deepStrictEqual(region.read(s), { mode: 'auto' });
});

test('clear returns to auto and removes the record', () => {
  const s = fakeStorage();
  region.write(s, { mode: 'region', place: 'X', stations: [] });
  assert.deepStrictEqual(region.clear(s), { mode: 'auto' });
  assert.deepStrictEqual(region.read(s), { mode: 'auto' });
});

test('normalizeRadius snaps invalid values to the default', () => {
  assert.strictEqual(region.normalizeRadius(150), 150);
  assert.strictEqual(region.normalizeRadius(999), region.DEFAULT_RADIUS);
  assert.strictEqual(region.normalizeRadius(undefined), region.DEFAULT_RADIUS);
});

test('normalizeRange snaps invalid values to the default', () => {
  assert.strictEqual(region.normalizeRange(30), 30);
  assert.strictEqual(region.normalizeRange(99), region.DEFAULT_RANGE);
});

test('parseResponse extracts region location fields from the config JSON', () => {
  const r = region.parseResponse(JSON.stringify({
    units: 1, locationMode: 'region', place: '  Tofino BC  ', radius: 150, range: 45,
  }));
  assert.deepStrictEqual(r, { mode: 'region', place: 'Tofino BC', radiusKm: 150, rangeDays: 45 });
});

test('parseResponse defaults to auto and snaps a bad radius', () => {
  const r = region.parseResponse(JSON.stringify({ locationMode: 'auto', radius: 7 }));
  assert.deepStrictEqual(r, { mode: 'auto', place: '', radiusKm: region.DEFAULT_RADIUS, rangeDays: region.DEFAULT_RANGE });
});

test('parseResponse returns null on garbage', () => {
  assert.strictEqual(region.parseResponse('not json'), null);
});
