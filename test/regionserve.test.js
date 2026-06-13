'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const regionserve = require('../src/pkjs/regionserve');
const blobcache = require('../src/pkjs/blobcache');

function fakeStorage() {
  const m = {};
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
  };
}
function stn(id, lon) {
  return { id: id, officialName: id, latitude: 0, longitude: lon, provider: 'noaa', operating: true };
}

test('pickServe returns the nearest cached station and its bytes (no network)', () => {
  const s = fakeStorage();
  const region = { mode: 'region', stations: [stn('A', 0), stn('B', 1.0)] };
  blobcache.setBytes(s, 'A', new Uint8Array([10]), '2026-06-13', 3);
  blobcache.setBytes(s, 'B', new Uint8Array([20]), '2026-06-13', 3);

  const out = regionserve.pickServe(region, 0, 0.9, s); // GPS nearest B
  assert.strictEqual(out.station.id, 'B');
  assert.deepStrictEqual(Array.from(out.u8), [20]);
});

test('pickServe skips the nearest station when its blob is missing', () => {
  const s = fakeStorage();
  const region = { mode: 'region', stations: [stn('A', 0), stn('B', 1.0)] };
  blobcache.setBytes(s, 'B', new Uint8Array([20]), '2026-06-13', 3); // only B cached
  const out = regionserve.pickServe(region, 0, 0.1, s); // GPS nearest A, but A uncached
  assert.strictEqual(out.station.id, 'B');
});

test('pickServe returns null when no station in the region is cached', () => {
  const region = { mode: 'region', stations: [stn('A', 0), stn('B', 1.0)] };
  assert.strictEqual(regionserve.pickServe(region, 0, 0, fakeStorage()), null);
});

test('pickServe returns null for an empty region', () => {
  assert.strictEqual(regionserve.pickServe({ mode: 'region', stations: [] }, 0, 0, fakeStorage()), null);
});
