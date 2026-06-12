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

test('hiloUrl builds the getTidesTable URL with aac/date/days/region/tz', () => {
  const station = {
    id: 'TAS_TP003', provider: 'bom', region: 'TAS', tz: 'Australia/Hobart',
  };
  const from = new Date('2026-06-10T00:00:00Z');
  const to = new Date('2026-06-18T00:00:00Z'); // 8 days
  const url = bom.hiloUrl(station, from, to);
  assert.ok(url.indexOf('getTidesTable.php') !== -1, url);
  assert.ok(url.indexOf('type=tide') !== -1);
  assert.ok(url.indexOf('aac=TAS_TP003') !== -1);
  assert.ok(url.indexOf('date=10-06-2026') !== -1, 'DD-MM-YYYY of from: ' + url);
  assert.ok(url.indexOf('days=8') !== -1, 'whole-day span: ' + url);
  assert.ok(url.indexOf('region=TAS') !== -1);
  assert.ok(url.indexOf('tz=Australia%2FHobart') !== -1, 'tz url-encoded: ' + url);
});

const TABLE_HTML = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'bom-tides-table.html'), 'utf8'
);

test('parseHilo extracts {epoch, heightCm, kind} from the HTML table', () => {
  const pts = bom.parseHilo(TABLE_HTML);
  assert.deepStrictEqual(pts, [
    { epoch: 1781115120, heightCm: 112, kind: 1 },
    { epoch: 1781134620, heightCm: 75, kind: 2 },
    { epoch: 1781159100, heightCm: 149, kind: 1 },
    { epoch: 1781185080, heightCm: 62, kind: 2 },
  ]);
});

test('parseHilo classifies high=1 low=2 from cell class', () => {
  const pts = bom.parseHilo(TABLE_HTML);
  assert.strictEqual(pts[0].kind, 1); // High
  assert.strictEqual(pts[1].kind, 2); // Low
});

test('parseHilo returns [] on non-string / empty / no matches', () => {
  assert.deepStrictEqual(bom.parseHilo(null), []);
  assert.deepStrictEqual(bom.parseHilo(''), []);
  assert.deepStrictEqual(bom.parseHilo('<html>no tides here</html>'), []);
});

const registry = require('../src/pkjs/providers');

test('bom declares text responseFormat and a browser User-Agent', () => {
  assert.strictEqual(bom.responseFormat, 'text');
  assert.ok(bom.requestHeaders);
  assert.ok(/Mozilla\/5\.0/.test(bom.requestHeaders['User-Agent']));
});

test('registry routes provider:"bom" to the BOM adapter', () => {
  const adapter = registry.forStation({ provider: 'bom', id: 'TAS_TP003' });
  assert.strictEqual(adapter, bom);
});

// Issue 1: attribute order must not matter — class before data-time-utc
test('parseHilo is order-independent: class attr before data-time-utc', () => {
  // Same data as a real high-tide cell but class= written before data-time-utc=
  var html =
    '<td class="localtime high-tide" data-time-utc="2026-06-10T04:32:00Z">4:32 am</td>' +
    '<td class="height high-tide">1.12 m</td>';
  const pts = bom.parseHilo(html);
  assert.strictEqual(pts.length, 1);
  assert.strictEqual(pts[0].kind, 1);
  assert.strictEqual(pts[0].heightCm, 112);
  assert.strictEqual(pts[0].epoch, Math.floor(Date.parse('2026-06-10T04:32:00Z') / 1000));
});

// Issue 2: time/height count mismatch must return [] not silently corrupt
test('parseHilo returns [] when time and height counts differ', () => {
  // 2 time cells but only 1 height cell
  var html =
    '<td data-time-utc="2026-06-10T04:32:00Z" class="localtime high-tide">4:32 am</td>' +
    '<td data-time-utc="2026-06-10T10:00:00Z" class="localtime low-tide">10:00 am</td>' +
    '<td class="height high-tide">1.12 m</td>';
  assert.deepStrictEqual(bom.parseHilo(html), []);
});
