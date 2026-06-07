'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { haversineKm, nearestUsableStation } = require('../src/pkjs/geo');

const FIXTURE = [
  { id: 'amb', officialName: 'Ambleside', operating: true, latitude: 49.32577, longitude: -123.15458 },
  { id: 'kit', officialName: 'Kitsilano', operating: true, latitude: 49.276583, longitude: -123.13936 },
  { id: 'ren', officialName: 'Port Renfrew', operating: true, latitude: 48.555, longitude: -124.42 },
];

test('haversineKm measures the great-circle distance between two points', () => {
  // Ambleside -> Kitsilano is ~5.58 km
  const d = haversineKm(49.32577, -123.15458, 49.276583, -123.13936);
  assert.ok(Math.abs(d - 5.58) < 0.05, `expected ~5.58 km, got ${d}`);
});

test('nearestUsableStation returns the closest station to a position', () => {
  const result = nearestUsableStation(FIXTURE, 49.27, -123.14); // right by Kitsilano
  assert.strictEqual(result.station.id, 'kit');
});

test('nearestUsableStation skips operating:false even when it is closest', () => {
  const withDead = [
    { id: 'dead', officialName: 'Bad Data', operating: false, latitude: 49.27, longitude: -123.14 },
    ...FIXTURE,
  ];
  const result = nearestUsableStation(withDead, 49.27, -123.14); // sits on the dead station
  assert.strictEqual(result.station.id, 'kit');
});

test('nearestUsableStation reports distanceKm and returns null when none are usable', () => {
  const near = nearestUsableStation(FIXTURE, 49.32577, -123.15458); // on Ambleside
  assert.strictEqual(near.station.id, 'amb');
  assert.ok(near.distanceKm < 0.01, `expected ~0 km, got ${near.distanceKm}`);

  const allDead = FIXTURE.map((s) => ({ ...s, operating: false }));
  assert.strictEqual(nearestUsableStation(allDead, 49.27, -123.14), null);
});
