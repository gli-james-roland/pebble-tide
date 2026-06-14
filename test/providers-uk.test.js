'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const uk = require('../src/pkjs/providers/uk');

// Minimal GetStations GeoJSON: one British-Isles feature, one non-whitelist.
const STATIONS = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { Id: '0113', Name: 'Dover', Country: 'England' },
      geometry: { type: 'Point', coordinates: [1.3225, 51.1142] },
    },
    {
      type: 'Feature',
      properties: { Id: '9999', Name: 'Gibraltar', Country: 'Gibraltar' },
      geometry: { type: 'Point', coordinates: [-5.353, 36.144] },
    },
  ],
};

test('catalogUrl returns the EasyTide GetStations URL', () => {
  assert.strictEqual(
    uk.catalogUrl(),
    'https://easytide.admiralty.co.uk/Home/GetStations'
  );
});

test('parseCatalog keeps British-Isles features, trims, tags provider:"uk"', () => {
  const recs = uk.parseCatalog(STATIONS);
  assert.strictEqual(recs.length, 1);
  assert.deepStrictEqual(recs[0], {
    id: '0113',
    name: 'Dover',
    lat: 51.1142, // coordinates[1]
    lng: 1.3225, // coordinates[0]
    provider: 'uk',
  });
});

test('parseCatalog excludes non-whitelist Country', () => {
  const recs = uk.parseCatalog(STATIONS);
  assert.ok(!recs.some((r) => r.id === '9999'));
});

test('parseCatalog accepts every British-Isles Country value', () => {
  const countries = [
    'England', 'Scotland', 'Wales', 'Northern Ireland',
    'Ireland', 'Channel Islands', 'Isle of Man',
  ];
  const json = {
    features: countries.map((c, i) => ({
      properties: { Id: 'x' + i, Name: c + ' port', Country: c },
      geometry: { coordinates: [i, i + 50] },
    })),
  };
  assert.strictEqual(uk.parseCatalog(json).length, countries.length);
});

test('parseCatalog returns [] on null/garbage/missing features', () => {
  assert.deepStrictEqual(uk.parseCatalog(null), []);
  assert.deepStrictEqual(uk.parseCatalog({}), []);
  assert.deepStrictEqual(uk.parseCatalog({ features: 'nope' }), []);
});

test('hiloUrl builds GetPredictionData with encoded stationId, ignores from/to', () => {
  const url = uk.hiloUrl({ id: '0113', provider: 'uk' }, new Date(0), new Date());
  assert.strictEqual(
    url,
    'https://easytide.admiralty.co.uk/Home/GetPredictionData?stationId=0113'
  );
});

const PRED = {
  tidalEventList: [
    { eventType: 0, dateTime: '2026-06-13T03:51:00', height: 6.42 },
    { eventType: 1, dateTime: '2026-06-13T10:12:00', height: 0.78 },
  ],
};

test('parseHilo maps events to {epoch, heightCm, kind} with UTC epochs', () => {
  const pts = uk.parseHilo(PRED);
  assert.deepStrictEqual(pts, [
    {
      epoch: Math.floor(Date.parse('2026-06-13T03:51:00Z') / 1000),
      heightCm: 642,
      kind: 1,
    },
    {
      epoch: Math.floor(Date.parse('2026-06-13T10:12:00Z') / 1000),
      heightCm: 78,
      kind: 2,
    },
  ]);
});

test('parseHilo treats dateTime (no offset) as UTC', () => {
  const pts = uk.parseHilo(PRED);
  // Known UTC instant: 2026-06-13T03:51:00Z = 1781322660
  assert.strictEqual(pts[0].epoch, 1781322660);
});

test('parseHilo classifies eventType 0=High(1), 1=Low(2)', () => {
  const pts = uk.parseHilo(PRED);
  assert.strictEqual(pts[0].kind, 1);
  assert.strictEqual(pts[1].kind, 2);
});

test('parseHilo returns [] on missing/garbage tidalEventList', () => {
  assert.deepStrictEqual(uk.parseHilo(null), []);
  assert.deepStrictEqual(uk.parseHilo({}), []);
  assert.deepStrictEqual(uk.parseHilo({ tidalEventList: 'nope' }), []);
});

const registry = require('../src/pkjs/providers');

test('registry routes provider:"uk" to the UK adapter', () => {
  const adapter = registry.forStation({ provider: 'uk', id: '0113' });
  assert.strictEqual(adapter, uk);
});
