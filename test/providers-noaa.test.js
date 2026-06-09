'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const noaa = require('../src/pkjs/providers/noaa');
const dfo = require('../src/pkjs/providers/dfo');
const providers = require('../src/pkjs/providers');

test('hiloUrl builds the NOAA CO-OPS datagetter URL with correct query params', () => {
  const station = { id: '9447130' };
  const from = new Date('2026-01-05T00:00:00Z');
  const to = new Date('2026-02-03T00:00:00Z');
  const url = noaa.hiloUrl(station, from, to);
  assert.ok(url.indexOf('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter') === 0, 'starts with NOAA host');
  assert.ok(url.indexOf('station=9447130') !== -1, 'includes station id');
  assert.ok(url.indexOf('product=predictions') !== -1, 'requests predictions');
  assert.ok(url.indexOf('interval=hilo') !== -1, 'requests hilo interval');
  assert.ok(url.indexOf('datum=MLLW') !== -1, 'MLLW datum');
  assert.ok(url.indexOf('units=metric') !== -1, 'metric units');
  assert.ok(url.indexOf('time_zone=gmt') !== -1, 'gmt time zone');
  assert.ok(url.indexOf('format=json') !== -1, 'json format');
  assert.ok(url.indexOf('application=pebble_tides') !== -1, 'application tag');
  assert.ok(url.indexOf('begin_date=20260105') !== -1, 'begin_date zero-padded UTC yyyyMMdd');
  assert.ok(url.indexOf('end_date=20260203') !== -1, 'end_date zero-padded UTC yyyyMMdd');
});

test('parseHilo maps {t,v,type} to {epoch, heightCm, kind} with H=1 L=2 and UTC epochs', () => {
  const json = {
    predictions: [
      { t: '2026-06-08 01:23', v: '3.21', type: 'H' },
      { t: '2026-06-08 07:45', v: '0.42', type: 'L' },
    ],
  };
  const points = noaa.parseHilo(json);
  assert.deepStrictEqual(points.map((p) => p.kind), [1, 2]);
  assert.deepStrictEqual(points.map((p) => p.heightCm), [321, 42]);
  assert.strictEqual(points[0].epoch, Math.floor(Date.parse('2026-06-08T01:23:00Z') / 1000));
  assert.strictEqual(points[1].epoch, Math.floor(Date.parse('2026-06-08T07:45:00Z') / 1000));
});

test('parseHilo handles negative heights', () => {
  const json = { predictions: [{ t: '2026-06-08 07:45', v: '-0.50', type: 'L' }] };
  const points = noaa.parseHilo(json);
  assert.strictEqual(points[0].heightCm, -50);
});

test('parseHilo returns [] for missing or non-array predictions', () => {
  assert.deepStrictEqual(noaa.parseHilo(undefined), []);
  assert.deepStrictEqual(noaa.parseHilo(null), []);
  assert.deepStrictEqual(noaa.parseHilo({}), []);
  assert.deepStrictEqual(noaa.parseHilo({ predictions: 'nope' }), []);
});

test('registry forStation returns the noaa adapter for a noaa station and dfo for dfo', () => {
  assert.strictEqual(providers.forStation({ provider: 'noaa' }), noaa);
  assert.strictEqual(providers.forStation({ provider: 'dfo' }), dfo);
});

test('catalogUrl points at the NOAA MDAPI tidepredictions stations list', () => {
  assert.strictEqual(
    noaa.catalogUrl(),
    'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions'
  );
});

test('parseCatalog trims records, keeps both R and S, coerces id to string, tags provider', () => {
  const json = {
    count: 2,
    stations: [
      { id: 9447130, name: 'Seattle', lat: 47.6, lng: -122.3, type: 'R' },
      { id: 9447131, name: 'Sub', lat: 47.7, lng: -122.4, type: 'S' },
    ],
  };
  const records = noaa.parseCatalog(json);
  assert.deepStrictEqual(records, [
    { id: '9447130', name: 'Seattle', lat: 47.6, lng: -122.3, provider: 'noaa' },
    { id: '9447131', name: 'Sub', lat: 47.7, lng: -122.4, provider: 'noaa' },
  ]);
});

test('parseCatalog returns [] for missing or non-array stations', () => {
  assert.deepStrictEqual(noaa.parseCatalog(undefined), []);
  assert.deepStrictEqual(noaa.parseCatalog({}), []);
  assert.deepStrictEqual(noaa.parseCatalog({ stations: 'nope' }), []);
});
