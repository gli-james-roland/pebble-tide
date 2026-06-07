'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { packWeek, unpackWeek, chunkBytes, BLOB_VERSION } = require('../src/pkjs/blob');

const STATION = { officialName: 'Kitsilano' };
const EXTREMA = [
  { epoch: 1780814820, heightCm: 449, type: 'HIGH' },
  { epoch: 1780838460, heightCm: 294, type: 'LOW' },
  { epoch: 1780850880, heightCm: 318, type: 'HIGH' },
];

test('packWeek/unpackWeek round-trips station, distance, and extrema', () => {
  const bytes = packWeek(EXTREMA, STATION, 6);
  const out = unpackWeek(bytes);

  assert.strictEqual(out.version, BLOB_VERSION);
  assert.strictEqual(out.stationName, 'Kitsilano');
  assert.strictEqual(out.distanceKm, 6);
  assert.deepStrictEqual(out.extrema, EXTREMA);
});

test('chunkBytes splits into fixed-size chunks that reassemble to the original', () => {
  const data = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const chunks = chunkBytes(data, 4);
  assert.strictEqual(chunks.length, 3);
  assert.deepStrictEqual(Array.from(chunks[0]), [1, 2, 3, 4]);
  assert.deepStrictEqual(Array.from(chunks[2]), [9, 10]); // last is short

  const rejoined = [];
  chunks.forEach((c) => c.forEach((b) => rejoined.push(b)));
  assert.deepStrictEqual(rejoined, Array.from(data));
});
