'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { packWeek, unpackWeek, chunkBytes, BLOB_VERSION } = require('../src/pkjs/blob');

const STATION = { officialName: 'Kitsilano' };
const POINTS = [
  { epoch: 1780814400, heightCm: 410, kind: 0 },
  { epoch: 1780814820, heightCm: 449, kind: 1 }, // HIGH
  { epoch: 1780838460, heightCm: 294, kind: 2 }, // LOW
];
const SUN_DAYS = [
  { sunriseEpoch: 1780750800, sunsetEpoch: 1780808400 },
  { sunriseEpoch: 1780837200, sunsetEpoch: 1780894800 },
];

test('packWeek/unpackWeek round-trips station, distance, points, and sun days', () => {
  const bytes = packWeek(POINTS, STATION, 6, SUN_DAYS);
  const out = unpackWeek(bytes);

  assert.strictEqual(out.version, BLOB_VERSION);
  assert.strictEqual(out.stationName, 'Kitsilano');
  assert.strictEqual(out.distanceKm, 6);
  assert.strictEqual(out.far, false);
  assert.deepStrictEqual(out.points, POINTS);
  assert.deepStrictEqual(out.sunDays, SUN_DAYS);
});

test('packWeek tolerates missing sun days (empty array round-trips)', () => {
  const out = unpackWeek(packWeek(POINTS, STATION, 6));
  assert.deepStrictEqual(out.points, POINTS);
  assert.deepStrictEqual(out.sunDays, []);
});

test('packWeek sets the far flag when the station is beyond 500 km', () => {
  const out = unpackWeek(packWeek(POINTS, STATION, 4200, SUN_DAYS));
  assert.strictEqual(out.far, true);
  assert.strictEqual(out.distanceKm, 4200);
});

test('chunkBytes splits into fixed-size chunks that reassemble to the original', () => {
  const data = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const chunks = chunkBytes(data, 4);
  assert.strictEqual(chunks.length, 3);
  assert.deepStrictEqual(Array.from(chunks[0]), [1, 2, 3, 4]);
  assert.deepStrictEqual(Array.from(chunks[2]), [9, 10]);

  const rejoined = [];
  chunks.forEach((c) => c.forEach((b) => rejoined.push(b)));
  assert.deepStrictEqual(rejoined, Array.from(data));
});
