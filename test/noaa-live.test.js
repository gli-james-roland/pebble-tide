'use strict';

// Live smoke test against the real NOAA CO-OPS API (#32/#33). Confirms the
// catalog and hilo URLs our adapter builds still return JSON our parsers
// understand -- catches NOAA changing their response shape.
//
// Network-dependent and slow, so it is SKIPPED by default. Run it with:
//   LIVE_NOAA=1 node --test test/noaa-live.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const noaa = require('../src/pkjs/providers/noaa');

const LIVE = !!process.env.LIVE_NOAA;
const SEATTLE = { id: '9447130', provider: 'noaa' };

async function getJson(url) {
  const res = await fetch(url);
  assert.ok(res.ok, `HTTP ${res.status} for ${url}`);
  return res.json();
}

test('live: MDAPI catalog returns parseable NOAA stations including Seattle', { skip: !LIVE }, async () => {
  const json = await getJson(noaa.catalogUrl());
  const stations = noaa.parseCatalog(json);
  assert.ok(stations.length > 100, `expected a full catalog, got ${stations.length}`);
  for (const s of stations.slice(0, 50)) {
    assert.strictEqual(typeof s.id, 'string');
    assert.strictEqual(s.provider, 'noaa');
    assert.ok(Number.isFinite(s.lat) && Number.isFinite(s.lng), 'lat/lng must be numeric');
  }
  assert.ok(stations.some((s) => s.id === '9447130'), 'Seattle 9447130 must be in the catalog');
});

test('live: hilo predictions for Seattle parse into sane extrema', { skip: !LIVE }, async () => {
  const from = new Date();
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  const json = await getJson(noaa.hiloUrl(SEATTLE, from, to));
  const extrema = noaa.parseHilo(json);
  assert.ok(extrema.length >= 2, `expected >=2 hilo events in 24h, got ${extrema.length}`);
  const nowSec = Math.floor(from.getTime() / 1000) - 6 * 3600; // allow some past slop
  for (const e of extrema) {
    assert.ok(Number.isInteger(e.epoch) && e.epoch > nowSec, `epoch out of range: ${e.epoch}`);
    assert.ok(e.kind === 1 || e.kind === 2, `kind must be 1|2, got ${e.kind}`);
    assert.ok(Number.isInteger(e.heightCm), `heightCm must be int cm, got ${e.heightCm}`);
  }
  // tides alternate high/low, so both kinds should appear over a day
  assert.ok(extrema.some((e) => e.kind === 1) && extrema.some((e) => e.kind === 2),
    'expected both highs and lows over 24h');
});
