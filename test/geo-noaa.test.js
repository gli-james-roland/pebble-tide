'use strict';

// Geo selection across providers (#32/#33). Proves a Pacific-Northwest position
// resolves to the NOAA station and a BC position still resolves to DFO, running
// the real unionStations -> nearestUsableStation path that index.js uses.
const { test } = require('node:test');
const assert = require('node:assert');
const catalog = require('../src/pkjs/catalog');
const geo = require('../src/pkjs/geo');
const STATIONS = require('../src/pkjs/stations');

function fakeStorage(seed) {
  return {
    store: seed || {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
    setItem(k, v) { this.store[k] = v; },
  };
}

test('seed-only union: a Seattle position selects the NOAA seed station', () => {
  const union = catalog.unionStations({}, STATIONS);
  const r = geo.nearestUsableStation(union, 47.61, -122.35); // downtown Seattle
  assert.strictEqual(r.station.provider, 'noaa');
  assert.strictEqual(r.station.id, '9447130');
});

test('seed-only union: a BC position still selects a DFO station', () => {
  const union = catalog.unionStations({}, STATIONS);
  const r = geo.nearestUsableStation(union, 49.27, -123.14); // Kitsilano
  assert.strictEqual(r.station.provider, 'dfo');
});

test('catalog-backed union: a fetched NOAA slice feeds geo via normalization', () => {
  // MDAPI-shape records (name/lat/lng) must normalize to the seed shape
  // (officialName/latitude/longitude) or nearestUsableStation cannot read them.
  const s = fakeStorage();
  catalog.writeSlice(s, 'noaa', [
    { id: '9447130', name: 'Seattle', lat: 47.602638, lng: -122.339432, provider: 'noaa' },
    { id: '9449880', name: 'Friday Harbor', lat: 48.546389, lng: -123.009722, provider: 'noaa' },
  ], 1, 1);
  const union = catalog.unionStations(catalog.readCache(s), STATIONS);

  const seattle = geo.nearestUsableStation(union, 47.61, -122.35);
  assert.strictEqual(seattle.station.id, '9447130');
  assert.strictEqual(seattle.station.provider, 'noaa');
  assert.ok(seattle.distanceKm < 5, `expected <5 km, got ${seattle.distanceKm}`);

  const fridayHarbor = geo.nearestUsableStation(union, 48.55, -123.01);
  assert.strictEqual(fridayHarbor.station.id, '9449880');
});

test('catalog-backed union: NOAA slice replaces the NOAA seed (no seed Seattle)', () => {
  const s = fakeStorage();
  catalog.writeSlice(s, 'noaa', [
    { id: '9449880', name: 'Friday Harbor', lat: 48.546389, lng: -123.009722, provider: 'noaa' },
  ], 1, 1);
  const union = catalog.unionStations(catalog.readCache(s), STATIONS);
  const noaaIds = union.filter((x) => x.provider === 'noaa').map((x) => x.id);
  assert.deepStrictEqual(noaaIds, ['9449880']); // seed 9447130 dropped, slice wins
});
