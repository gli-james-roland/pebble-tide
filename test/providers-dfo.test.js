'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const dfo = require('../src/pkjs/providers/dfo');
const providers = require('../src/pkjs/providers');
const STATIONS = require('../src/pkjs/stations');

test('hiloUrl builds the DFO IWLS wlp-hilo URL for a station and date window', () => {
  const station = { id: '5cebf1de3d0f4a073c4bb94c', provider: 'dfo' };
  const from = new Date('2026-06-07T00:00:00Z');
  const to = new Date('2026-06-14T00:00:00Z');
  const url = dfo.hiloUrl(station, from, to);
  assert.ok(url.indexOf('https://api-iwls.dfo-mpo.gc.ca') === 0, 'starts with IWLS host');
  assert.ok(url.indexOf('/api/v1/stations/5cebf1de3d0f4a073c4bb94c/data') !== -1, 'includes station id path');
  assert.ok(url.indexOf('time-series-code=wlp-hilo') !== -1, 'requests wlp-hilo series');
  assert.ok(url.indexOf('resolution=ALL') !== -1, 'requests ALL resolution');
  assert.ok(url.indexOf('from=2026-06-07T00:00:00Z') !== -1, 'from ISO substring');
  assert.ok(url.indexOf('to=2026-06-14T00:00:00Z') !== -1, 'to ISO substring');
});

test('parseHilo returns {epoch, heightCm, kind} with kind 1 for highs and 2 for lows', () => {
  const json = [
    { eventDate: '2026-06-08T01:23:00Z', value: 3.21 },
    { eventDate: '2026-06-08T07:45:00Z', value: 1.05 },
    { eventDate: '2026-06-08T13:50:00Z', value: 3.40 },
    { eventDate: '2026-06-08T20:10:00Z', value: 0.90 },
  ];
  const points = dfo.parseHilo(json);
  assert.deepStrictEqual(points.map((p) => p.kind), [1, 2, 1, 2]);
  assert.strictEqual(points[0].epoch, Math.floor(Date.parse('2026-06-08T01:23:00Z') / 1000));
  assert.strictEqual(points[0].heightCm, 321);
  assert.strictEqual(points[1].heightCm, 105);
});

test('parseHilo matches the old inline classify+map output shape', () => {
  const tides = require('../src/pkjs/tides');
  const json = [
    { eventDate: '2026-06-07T06:47:00Z', value: 4.494 },
    { eventDate: '2026-06-07T13:31:00Z', value: 2.939 },
  ];
  const old = tides.classifyExtrema(json).map((x) => ({
    epoch: x.epoch, heightCm: x.heightCm, kind: x.type === 'HIGH' ? 1 : 2,
  }));
  assert.deepStrictEqual(dfo.parseHilo(json), old);
});

test('registry forStation returns the dfo adapter for a dfo station', () => {
  const adapter = providers.forStation({ provider: 'dfo' });
  assert.strictEqual(adapter, dfo);
});

test('registry forStation throws on an unknown provider', () => {
  assert.throws(() => providers.forStation({ provider: 'noaa' }), /provider/i);
});

test('every seed station carries provider "dfo"', () => {
  assert.ok(STATIONS.length > 0);
  for (const s of STATIONS) {
    assert.strictEqual(s.provider, 'dfo', s.officialName + ' must be a dfo station');
  }
});
