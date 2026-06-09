'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const catalog = require('../src/pkjs/catalog');
const geo = require('../src/pkjs/geo');

function fakeStorage(seed) {
  return {
    store: seed || {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
    setItem(k, v) { this.store[k] = v; },
  };
}

test('readCache returns {} when the key is absent', () => {
  assert.deepStrictEqual(catalog.readCache(fakeStorage()), {});
});

test('readCache returns {} when the stored JSON is corrupt', () => {
  const s = fakeStorage({ stationCatalog: '{not json' });
  assert.deepStrictEqual(catalog.readCache(s), {});
});

test('readCache returns the parsed object when valid', () => {
  const cache = { noaa: { stations: [{ id: '1' }], fetchedAt: 123 } };
  const s = fakeStorage({ stationCatalog: JSON.stringify(cache) });
  assert.deepStrictEqual(catalog.readCache(s), cache);
});

test('writeSlice persists a slice and preserves an existing other slice', () => {
  const s = fakeStorage({
    stationCatalog: JSON.stringify({ dfo: { stations: [{ id: 'd1' }], fetchedAt: 1, version: 3 } }),
  });
  catalog.writeSlice(s, 'noaa', [{ id: 'n1' }], 999, 3);
  const out = JSON.parse(s.store.stationCatalog);
  assert.deepStrictEqual(out.dfo, { stations: [{ id: 'd1' }], fetchedAt: 1, version: 3 });
  assert.deepStrictEqual(out.noaa, { stations: [{ id: 'n1' }], fetchedAt: 999, version: 3 });
});

test('writeSlice persists the version alongside fetchedAt (round-trips via readCache)', () => {
  const s = fakeStorage();
  catalog.writeSlice(s, 'dfo', [{ id: 'd1' }], 42, 7);
  const cache = catalog.readCache(s);
  assert.deepStrictEqual(cache.dfo, { stations: [{ id: 'd1' }], fetchedAt: 42, version: 7 });
});

const SEED = [
  { provider: 'dfo', id: 'd1', officialName: 'Victoria', operating: true, latitude: 48.42, longitude: -123.37 },
  { provider: 'noaa', id: '9447130', officialName: 'Seattle', operating: true, latitude: 47.6, longitude: -122.34 },
];

test('unionStations: live noaa slice replaces seed noaa, seed dfo fills empty dfo slice (no dupes)', () => {
  const cache = {
    noaa: { stations: [{ id: '9449880', name: 'Friday Harbor', lat: 48.55, lng: -123.0, provider: 'noaa' }], fetchedAt: 1 },
  };
  const union = catalog.unionStations(cache, SEED);
  const ids = union.map((s) => s.id).sort();
  // live noaa station + seed dfo; seed Seattle NOT present (noaa came from cache)
  assert.deepStrictEqual(ids, ['9449880', 'd1']);
  assert.ok(!union.some((s) => s.id === '9447130'), 'seed Seattle not duplicated');
});

test('unionStations: empty cache returns the seed (normalized id/lat/lng equality)', () => {
  const union = catalog.unionStations({}, SEED);
  const byId = {};
  union.forEach((s) => { byId[s.id] = s; });
  assert.strictEqual(union.length, SEED.length);
  SEED.forEach((seed) => {
    assert.strictEqual(byId[seed.id].latitude, seed.latitude);
    assert.strictEqual(byId[seed.id].longitude, seed.longitude);
    assert.strictEqual(byId[seed.id].provider, seed.provider);
  });
});

test('unionStations normalizes trimmed catalog records to the seed shape', () => {
  const cache = {
    noaa: { stations: [{ id: '9449880', name: 'Friday Harbor', lat: 48.55, lng: -123.0, provider: 'noaa' }], fetchedAt: 1 },
  };
  const union = catalog.unionStations(cache, []);
  assert.deepStrictEqual(union, [
    { id: '9449880', officialName: 'Friday Harbor', latitude: 48.55, longitude: -123.0, operating: true, provider: 'noaa' },
  ]);
});

test('selection picks a NOAA catalog station beyond the seed for a US coastal coordinate', () => {
  // Friday Harbor, WA — in the noaa cache slice, NOT in the seed.
  const cache = {
    noaa: { stations: [{ id: '9449880', name: 'Friday Harbor', lat: 48.5439, lng: -123.0119, provider: 'noaa' }], fetchedAt: 1 },
  };
  const union = catalog.unionStations(cache, SEED);
  const result = geo.nearestUsableStation(union, 48.5439, -123.0119);
  assert.strictEqual(result.station.id, '9449880');
  assert.strictEqual(result.station.provider, 'noaa');
});
