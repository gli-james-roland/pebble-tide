'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const geocode = require('../src/pkjs/geocode');

test('geocodeUrl builds a Nominatim query with limit=1', () => {
  const url = geocode.geocodeUrl('Hobart, TAS');
  assert.ok(url.indexOf('nominatim.openstreetmap.org/search') !== -1, url);
  assert.ok(url.indexOf('format=json') !== -1);
  assert.ok(url.indexOf('limit=1') !== -1);
  assert.ok(url.indexOf('q=Hobart%2C%20TAS') !== -1, url);
});

test('parseGeocode returns lat/lon from the first result', () => {
  const json = [{ lat: '-42.8821', lon: '147.3272', display_name: 'Hobart' }];
  assert.deepStrictEqual(geocode.parseGeocode(json), { lat: -42.8821, lon: 147.3272 });
});

test('parseGeocode returns null on empty/garbage/missing coords', () => {
  assert.strictEqual(geocode.parseGeocode([]), null);
  assert.strictEqual(geocode.parseGeocode(null), null);
  assert.strictEqual(geocode.parseGeocode([{ lat: 'x', lon: 'y' }]), null);
});
