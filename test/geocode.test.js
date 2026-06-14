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

// --- #63 case 2: geocode surfaces WHY it failed (offline vs notfound) ---
// geocode(place, cb) now calls cb(coords, reason). reason is null on success,
// 'offline' on a transport failure (network/timeout/HTTP error), 'notfound'
// on a well-formed empty result. The caller turns 'offline' into a
// connect-to-internet message instead of "Couldn't find".

function withFakeXhr(impl, run) {
  const prev = global.XMLHttpRequest;
  global.XMLHttpRequest = function () {
    this.open = function () {};
    this.setRequestHeader = function () {};
    this.send = impl.bind(this);
  };
  try { run(); } finally { global.XMLHttpRequest = prev; }
}

test('geocode reports null reason and coords on success', () => {
  let got;
  withFakeXhr(function () {
    this.status = 200;
    this.responseText = JSON.stringify([{ lat: '1.5', lon: '2.5' }]);
    this.onload();
  }, () => {
    geocode.geocode('somewhere', (coords, reason) => { got = { coords, reason }; });
  });
  assert.deepStrictEqual(got, { coords: { lat: 1.5, lon: 2.5 }, reason: null });
});

test('geocode reports notfound on a well-formed empty result', () => {
  let got;
  withFakeXhr(function () {
    this.status = 200;
    this.responseText = '[]';
    this.onload();
  }, () => {
    geocode.geocode('nowhere', (coords, reason) => { got = { coords, reason }; });
  });
  assert.deepStrictEqual(got, { coords: null, reason: 'notfound' });
});

test('geocode reports offline on a network error', () => {
  let got;
  withFakeXhr(function () { this.onerror(); }, () => {
    geocode.geocode('x', (coords, reason) => { got = { coords, reason }; });
  });
  assert.deepStrictEqual(got, { coords: null, reason: 'offline' });
});

test('geocode reports offline on a timeout', () => {
  let got;
  withFakeXhr(function () { this.ontimeout(); }, () => {
    geocode.geocode('x', (coords, reason) => { got = { coords, reason }; });
  });
  assert.deepStrictEqual(got, { coords: null, reason: 'offline' });
});

test('geocode reports offline on a non-2xx HTTP status', () => {
  let got;
  withFakeXhr(function () { this.status = 503; this.onload(); }, () => {
    geocode.geocode('x', (coords, reason) => { got = { coords, reason }; });
  });
  assert.deepStrictEqual(got, { coords: null, reason: 'offline' });
});
