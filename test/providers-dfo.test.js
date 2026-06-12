'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const dfo = require('../src/pkjs/providers/dfo');
const providers = require('../src/pkjs/providers');
const STATIONS = require('../src/pkjs/stations');

test('parseHilo returns [] for a non-array payload instead of throwing', () => {
  // IWLS normally returns an array; a non-array body (error object, null) must
  // not throw -- the caller treats [] as "no data, keep cache". Mirrors NOAA's
  // parseHilo, which already guards its own response shape.
  assert.deepStrictEqual(dfo.parseHilo(undefined), []);
  assert.deepStrictEqual(dfo.parseHilo(null), []);
  assert.deepStrictEqual(dfo.parseHilo({ error: 'nope' }), []);
});

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
  assert.throws(() => providers.forStation({ provider: 'bogus' }), /provider/i);
});

test('every seed station carries a known provider', () => {
  assert.ok(STATIONS.length > 0);
  for (const s of STATIONS) {
    assert.ok(s.provider === 'dfo' || s.provider === 'noaa' || s.provider === 'bom',
      s.officialName + ' must carry a known provider');
  }
});

test('catalogUrl points at the DFO IWLS stations list', () => {
  assert.strictEqual(dfo.catalogUrl(), 'https://api-iwls.dfo-mpo.gc.ca/api/v1/stations');
});

test('parseCatalog keeps only operating stations advertising wlp-hilo, trimmed', () => {
  const json = [
    { id: 'aaa', officialName: 'Halifax', latitude: 44.66, longitude: -63.58,
      operating: true, timeSeries: [{ code: 'wlp' }, { code: 'wlp-hilo' }] },
    { id: 'bbb', officialName: 'NoHilo', latitude: 45.0, longitude: -64.0,
      operating: true, timeSeries: [{ code: 'wlp' }] },
    { id: 'ccc', officialName: 'NotOperating', latitude: 46.0, longitude: -65.0,
      operating: false, timeSeries: [{ code: 'wlp-hilo' }] },
    { id: 'ddd', officialName: 'EmptySeries', latitude: 47.0, longitude: -66.0,
      operating: true, timeSeries: [] },
    { id: 'eee', officialName: 'MissingSeries', latitude: 48.0, longitude: -67.0,
      operating: true },
  ];
  const records = dfo.parseCatalog(json);
  assert.strictEqual(records.length, 1, 'only the operating wlp-hilo station is kept');
  assert.deepStrictEqual(records, [
    { id: 'aaa', name: 'Halifax', lat: 44.66, lng: -63.58, provider: 'dfo' },
  ]);
  assert.strictEqual(records[0].id, 'aaa', 'keeps the full original DFO id string');
});

test('parseCatalog returns [] for non-array input', () => {
  assert.deepStrictEqual(dfo.parseCatalog(undefined), []);
  assert.deepStrictEqual(dfo.parseCatalog(null), []);
  assert.deepStrictEqual(dfo.parseCatalog({}), []);
  assert.deepStrictEqual(dfo.parseCatalog({ stations: [] }), []);
});

test('a dfo cache slice with an Atlantic station is selected at that coordinate', () => {
  const catalog = require('../src/pkjs/catalog');
  const geo = require('../src/pkjs/geo');
  const cache = {
    dfo: {
      stations: [{ id: 'aaa', name: 'Halifax', lat: 44.66, lng: -63.58, provider: 'dfo' }],
      fetchedAt: 1,
    },
  };
  const candidates = catalog.unionStations(cache, STATIONS);
  const result = geo.nearestUsableStation(candidates, 44.65, -63.57);
  assert.ok(result, 'a station is selected');
  assert.strictEqual(result.station.id, 'aaa', 'picks the Atlantic-coast catalog station');
  assert.strictEqual(result.station.officialName, 'Halifax');
});
