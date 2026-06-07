'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { sunTimes } = require('../src/pkjs/sun');

// Vancouver, BC.
const LAT = 49.28;
const LON = -123.12;

// Minutes from the start of the given UTC day (handles times past midnight Z).
function minsFromUtcDay(epoch, dayMillis) {
  return (epoch * 1000 - dayMillis) / 60000;
}

// Within a few minutes of the authoritative NOAA / timeanddate values.
function assertNearUtc(epoch, dayMillis, h, m, label) {
  const got = minsFromUtcDay(epoch, dayMillis);
  const want = h * 60 + m;
  const diff = Math.abs(got - want);
  assert.ok(diff <= 4,
    label + ' expected ~' + want + 'm from day start, got ' +
    got.toFixed(1) + 'm (off ' + diff.toFixed(1) + 'm)');
}

test('Vancouver summer solstice 2025-06-21: sunrise ~12:07Z, sunset ~04:22Z (next day)', () => {
  const dayMillis = Date.UTC(2025, 5, 21, 0, 0, 0);
  const { sunriseEpoch, sunsetEpoch } = sunTimes(dayMillis + 12 * 3600000, LAT, LON);
  // PDT (UTC-7): sunrise 05:07 -> 12:07Z; sunset 21:22 -> 04:22Z on the 22nd.
  assertNearUtc(sunriseEpoch, dayMillis, 12, 7, 'sunrise');
  assertNearUtc(sunsetEpoch, dayMillis, 24 + 4, 22, 'sunset'); // crosses midnight UTC
  assert.ok(sunsetEpoch > sunriseEpoch, 'sunset after sunrise');
});

test('Vancouver winter 2025-12-21: short day, sunrise ~16:05Z, sunset ~00:16Z', () => {
  const dayMillis = Date.UTC(2025, 11, 21, 0, 0, 0);
  const { sunriseEpoch, sunsetEpoch } = sunTimes(dayMillis + 20 * 3600000, LAT, LON);
  // PST (UTC-8): sunrise 08:05 -> 16:05Z; sunset 16:16 -> 00:16Z next day.
  assertNearUtc(sunriseEpoch, dayMillis, 16, 5, 'sunrise');
  assertNearUtc(sunsetEpoch, dayMillis, 24 + 0, 16, 'sunset');
});
