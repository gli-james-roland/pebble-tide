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

// --- #63 case 3: offline launch fallback chain (no GPS fix) ---
// serveNoFix tries the LAST-SERVED station's coords first, then the region
// center, then gives up. Cache-only via pickServe.

test('serveNoFix serves from the last-served station coords first', () => {
  const s = fakeStorage();
  // A near lon 0, B near lon 10. Last served was B.
  const region = { mode: 'region', stations: [stn('A', 0), stn('B', 10)], center: { lat: 0, lon: 0 } };
  blobcache.setBytes(s, 'A', new Uint8Array([10]), '2026-06-13', 3);
  blobcache.setBytes(s, 'B', new Uint8Array([20]), '2026-06-13', 3);
  const last = { id: 'B', latitude: 0, longitude: 10 };
  const out = regionserve.serveNoFix(region, last, s);
  assert.strictEqual(out.station.id, 'B', 'nearest to last-served coords is B');
});

test('serveNoFix falls back to region center when there is no last-served station', () => {
  const s = fakeStorage();
  const region = { mode: 'region', stations: [stn('A', 0), stn('B', 10)], center: { lat: 0, lon: 0 } };
  blobcache.setBytes(s, 'A', new Uint8Array([10]), '2026-06-13', 3);
  blobcache.setBytes(s, 'B', new Uint8Array([20]), '2026-06-13', 3);
  const out = regionserve.serveNoFix(region, null, s);
  assert.strictEqual(out.station.id, 'A', 'nearest to center (lon 0) is A');
});

test('serveNoFix falls back to center when the last-served station is not cached', () => {
  const s = fakeStorage();
  const region = { mode: 'region', stations: [stn('A', 0), stn('B', 10)], center: { lat: 0, lon: 0 } };
  blobcache.setBytes(s, 'A', new Uint8Array([10]), '2026-06-13', 3); // only A cached
  const last = { id: 'B', latitude: 0, longitude: 10 };
  const out = regionserve.serveNoFix(region, last, s);
  assert.strictEqual(out.station.id, 'A', 'last-served B uncached -> center picks A');
});

test('serveNoFix returns null when nothing is cached and no center', () => {
  const s = fakeStorage();
  const region = { mode: 'region', stations: [stn('A', 0)], center: null };
  assert.strictEqual(regionserve.serveNoFix(region, null, s), null);
});
