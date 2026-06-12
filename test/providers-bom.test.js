'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const bom = require('../src/pkjs/providers/bom');

const SITES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'bom-sites.json'), 'utf8')
);

test('catalogUrl returns the BOM tide_prediction_sites.json URL', () => {
  assert.strictEqual(
    bom.catalogUrl(),
    'https://www.bom.gov.au/australia/tides/tide_prediction_sites.json'
  );
});

test('parseCatalog maps GeoJSON features to normalized records with tz/region', () => {
  const recs = bom.parseCatalog(SITES);
  // Two AVAIL_FLAG:'Y' features kept, the 'N' one dropped.
  assert.strictEqual(recs.length, 2);
  assert.deepStrictEqual(recs[0], {
    id: 'TAS_TP003',
    name: 'Hobart',
    lat: -42.87732777777778,
    lng: 147.34095277777777,
    provider: 'bom',
    tz: 'Australia/Hobart',
    region: 'TAS',
  });
  assert.strictEqual(recs[1].id, 'NSW_TP007');
  assert.strictEqual(recs[1].region, 'NSW');
});

test('parseCatalog drops AVAIL_FLAG !== "Y"', () => {
  const recs = bom.parseCatalog(SITES);
  assert.ok(!recs.some((r) => r.id === 'NT_TP999'));
});

test('parseCatalog returns [] on null/garbage/missing features', () => {
  assert.deepStrictEqual(bom.parseCatalog(null), []);
  assert.deepStrictEqual(bom.parseCatalog({}), []);
  assert.deepStrictEqual(bom.parseCatalog({ features: 'nope' }), []);
});
