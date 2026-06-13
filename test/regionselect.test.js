'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const regionselect = require('../src/pkjs/regionselect');

// Center (0,0). Along the equator, ~111.32 km per degree of longitude, so
// lon 0.5 ~ 56 km, lon 1.0 ~ 111 km, lon 2.0 ~ 222 km, lon 3.0 ~ 334 km.
function stn(id, lon, operating) {
  return { id: id, officialName: id, latitude: 0, longitude: lon, provider: 'noaa', operating: operating !== false };
}

test('selectRegion returns stations within the radius, nearest-first', () => {
  const cands = [stn('FAR', 2.0), stn('NEAR', 0.5), stn('MID', 1.0)];
  const r = regionselect.selectRegion(cands, 0, 0, 150, 10);
  assert.deepStrictEqual(r.stations.map((s) => s.id), ['NEAR', 'MID']);
  assert.strictEqual(r.truncated, false);
});

test('selectRegion clips to the cap and flags truncation, keeping the nearest', () => {
  const cands = [stn('A', 0.2), stn('B', 0.4), stn('C', 0.6), stn('D', 0.8)];
  const r = regionselect.selectRegion(cands, 0, 0, 150, 2);
  assert.deepStrictEqual(r.stations.map((s) => s.id), ['A', 'B']);
  assert.strictEqual(r.truncated, true);
});

test('selectRegion excludes non-operating stations', () => {
  const cands = [stn('DEAD', 0.3, false), stn('LIVE', 0.6)];
  const r = regionselect.selectRegion(cands, 0, 0, 150, 10);
  assert.deepStrictEqual(r.stations.map((s) => s.id), ['LIVE']);
});

test('selectRegion returns an empty, non-truncated set when nothing is in range', () => {
  const r = regionselect.selectRegion([stn('FAR', 3.0)], 0, 0, 150, 10);
  assert.deepStrictEqual(r.stations, []);
  assert.strictEqual(r.truncated, false);
});
