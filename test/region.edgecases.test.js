'use strict';
// Integration tests for the region edge cases (#63), driving the real index.js
// webviewclosed/ready glue under stubbed PebbleKit JS globals. Each case asserts
// the persisted region record (region.read) — the same record the config status
// page surfaces to the user.
//
//   case 1: empty region (no stations in radius)  -> clear error, no blobs
//   case 2: offline at pin (geocode transport fail) -> connect-to-internet error
//   case 3: GPS denied offline at launch          -> last-served, else center
//   case 4: localStorage quota mid-download        -> stop + mark truncated
const { test } = require('node:test');
const assert = require('node:assert');
const blob = require('../src/pkjs/blob');
const region = require('../src/pkjs/region');
const blobcache = require('../src/pkjs/blobcache');

// localStorage stub. failBlobWrites, when set, throws on tideBlob:* setItem to
// simulate a quota failure mid-download (case 4). The region record key still
// writes so we can read the truncated result back.
function fakeLocalStorage(opts) {
  const o = opts || {};
  const m = {};
  let blobWrites = 0;
  return {
    _map: m,
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => {
      if (o.failBlobAfter !== undefined && k.indexOf(blobcache.KEY_PREFIX) === 0) {
        if (blobWrites >= o.failBlobAfter) { throw new Error('QuotaExceededError'); }
        blobWrites++;
      }
      m[k] = String(v);
    },
    removeItem: (k) => { delete m[k]; },
  };
}

// XHR stub routing by URL. `routes` maps a substring -> handler(xhr). The handler
// drives the lifecycle (set status/responseText then call onload, or call
// onerror/ontimeout). An unrouted URL throws so a missed network call is loud.
function installXhr(routes) {
  global.XMLHttpRequest = function () {
    this._headers = {};
    this.open = function (m, url) { this._url = url; };
    this.setRequestHeader = function (n, v) { this._headers[n] = v; };
    this.send = function () {
      const keys = Object.keys(routes);
      for (let i = 0; i < keys.length; i++) {
        if (this._url.indexOf(keys[i]) !== -1) { routes[keys[i]](this); return; }
      }
      throw new Error('unrouted XHR: ' + this._url);
    };
  };
}

function loadIndexFresh() {
  delete require.cache[require.resolve('../src/pkjs/index.js')];
  require('../src/pkjs/index.js');
}

function setEnv(ls, geo) {
  const listeners = {};
  global.localStorage = ls;
  global.Pebble = {
    addEventListener: (name, fn) => { listeners[name] = fn; },
    sendAppMessage: (msg, ok) => { if (ok) { ok(); } },
    openURL: () => {},
  };
  Object.defineProperty(global, 'navigator', {
    value: { onLine: true, geolocation: geo || { getCurrentPosition: () => {} } },
    configurable: true, writable: true,
  });
  return listeners;
}

function teardown() {
  delete global.localStorage; delete global.XMLHttpRequest; delete global.Pebble;
}

// A config webview response selecting Region mode.
function regionResponse(place, radius, range) {
  return JSON.stringify({ locationMode: 'region', place: place, radius: radius, range: range });
}

test('#63 case 1: empty region (no stations in radius) -> clear error, no blobs', () => {
  const ls = fakeLocalStorage();
  // Geocode to a remote ocean point far from every seed station, small radius.
  installXhr({ 'nominatim': (x) => { x.status = 200; x.responseText = JSON.stringify([{ lat: 0, lon: 0 }]); x.onload(); } });
  const listeners = setEnv(ls);
  loadIndexFresh();
  // No ready() -> the pin path (webviewclosed) is what we exercise; ready()
  // would kick off cold-start catalog fetches unrelated to this case.
  listeners.webviewclosed({ response: regionResponse('Null Island', 25, 45) });

  const rec = region.read(ls);
  assert.strictEqual(rec.mode, 'region');
  assert.deepStrictEqual(rec.stations, [], 'no stations selected');
  assert.ok(/No stations within 25/.test(rec.error), 'clear empty-region error: ' + rec.error);
  // No tide blobs were written.
  const blobKeys = Object.keys(ls._map).filter((k) => k.indexOf(blobcache.KEY_PREFIX) === 0);
  assert.deepStrictEqual(blobKeys, [], 'no cached blobs for an empty region');
  teardown();
});

test('#63 case 2: offline at pin (geocode transport fail) -> connect-to-internet error, no broken state', () => {
  const ls = fakeLocalStorage();
  installXhr({ 'nominatim': (x) => { x.onerror(); } }); // transport failure
  const listeners = setEnv(ls);
  loadIndexFresh();
  listeners.webviewclosed({ response: regionResponse('Tofino BC', 75, 45) });

  const rec = region.read(ls);
  assert.strictEqual(rec.mode, 'region');
  assert.strictEqual(rec.center, null, 'no geocoded center on an offline pin');
  assert.deepStrictEqual(rec.stations, [], 'no partial station list');
  assert.strictEqual(rec.truncated, false);
  assert.ok(/[Cc]onnect to the internet/.test(rec.error), 'connect-to-internet error: ' + rec.error);
  assert.ok(!/Couldn't find/.test(rec.error), 'must not read as not-found');
  const blobKeys = Object.keys(ls._map).filter((k) => k.indexOf(blobcache.KEY_PREFIX) === 0);
  assert.deepStrictEqual(blobKeys, [], 'no blobs on an offline pin');
  teardown();
});

test('#63 case 3: GPS denied offline at launch -> serves last-served station from cache, zero network', () => {
  const ls = fakeLocalStorage();
  const now = Math.floor(Date.now() / 1000);
  const points = [
    { epoch: now - 3600, heightCm: 120, kind: 1 },
    { epoch: now + 3600, heightCm: 30, kind: 2 },
  ];
  const A = { id: 'A', officialName: 'Alpha', latitude: 47.0, longitude: -122.0, operating: true, provider: 'noaa' };
  const B = { id: 'B', officialName: 'Bravo', latitude: 47.0, longitude: -130.0, operating: true, provider: 'noaa' };
  const uA = blob.packWeek(points, A, 0, []);
  const uB = blob.packWeek(points, B, 0, []);
  blobcache.setBytes(ls, 'A', uA, '2026-06-13', blob.BLOB_VERSION);
  blobcache.setBytes(ls, 'B', uB, '2026-06-13', blob.BLOB_VERSION);
  region.write(ls, {
    mode: 'region', place: 'X', center: { lat: 47.0, lon: -122.0 },
    radiusKm: 300, cap: 400, stations: [A, B], rangeDays: 45,
    fetchedAt: '2026-06-13', truncated: false, error: null,
  });
  // Last served was the FAR station B (center would otherwise pick A).
  ls.setItem('lastStation', JSON.stringify({ id: 'B', latitude: 47.0, longitude: -130.0 }));

  let xhrCount = 0;
  global.XMLHttpRequest = function () { xhrCount++; };
  const sent = [];
  global.localStorage = ls;
  global.Pebble = {
    addEventListener: (n, fn) => { (setEnv._l || (setEnv._l = {}))[n] = fn; },
    sendAppMessage: (msg, ok) => { if (msg && msg.CHUNK_DATA) { sent.push(msg.CHUNK_DATA); } if (ok) { ok(); } },
    openURL: () => {},
  };
  Object.defineProperty(global, 'navigator', {
    value: { onLine: false, geolocation: { getCurrentPosition: (ok, err) => err({ code: 1, message: 'denied' }) } },
    configurable: true, writable: true,
  });
  loadIndexFresh();
  setEnv._l.ready();

  const reassembled = [].concat.apply([], sent);
  assert.deepStrictEqual(reassembled, Array.from(uB), 'served the LAST-SERVED station B, not center-nearest A');
  assert.strictEqual(xhrCount, 0, 'offline serve makes no network calls');
  setEnv._l = null;
  teardown();
});

test('#63 case 3b: GPS denied + no last-served -> falls back to center-nearest station', () => {
  const ls = fakeLocalStorage();
  const now = Math.floor(Date.now() / 1000);
  const points = [{ epoch: now - 3600, heightCm: 120, kind: 1 }, { epoch: now + 3600, heightCm: 30, kind: 2 }];
  const A = { id: 'A', officialName: 'Alpha', latitude: 47.0, longitude: -122.0, operating: true, provider: 'noaa' };
  const B = { id: 'B', officialName: 'Bravo', latitude: 47.0, longitude: -130.0, operating: true, provider: 'noaa' };
  blobcache.setBytes(ls, 'A', blob.packWeek(points, A, 0, []), '2026-06-13', blob.BLOB_VERSION);
  blobcache.setBytes(ls, 'B', blob.packWeek(points, B, 0, []), '2026-06-13', blob.BLOB_VERSION);
  region.write(ls, {
    mode: 'region', place: 'X', center: { lat: 47.0, lon: -122.0 },
    radiusKm: 300, cap: 400, stations: [A, B], rangeDays: 45, fetchedAt: '2026-06-13', truncated: false, error: null,
  });
  // No lastStation key set.
  let xhrCount = 0;
  global.XMLHttpRequest = function () { xhrCount++; };
  const sent = [];
  global.localStorage = ls;
  global.Pebble = {
    addEventListener: (n, fn) => { (setEnv._l || (setEnv._l = {}))[n] = fn; },
    sendAppMessage: (msg, ok) => { if (msg && msg.CHUNK_DATA) { sent.push(msg.CHUNK_DATA); } if (ok) { ok(); } },
    openURL: () => {},
  };
  Object.defineProperty(global, 'navigator', {
    value: { onLine: false, geolocation: { getCurrentPosition: (ok, err) => err({ code: 2, message: 'unavailable' }) } },
    configurable: true, writable: true,
  });
  loadIndexFresh();
  setEnv._l.ready();
  const reassembled = [].concat.apply([], sent);
  assert.deepStrictEqual(reassembled, Array.from(blob.packWeek(points, A, 0, [])), 'center-nearest A served when no last-served');
  assert.strictEqual(xhrCount, 0);
  setEnv._l = null;
  teardown();
});

test('#63 case 4: localStorage quota write failure mid-download -> stop + mark truncated, no throw', () => {
  // Fail the SECOND blob write so the first station lands and the loop stops.
  const ls = fakeLocalStorage({ failBlobAfter: 1 });
  // Provider hilo responses are shaped per provider (NOAA object, DFO array).
  const noaaHilo = (x) => {
    x.status = 200;
    x.responseText = JSON.stringify({ predictions: [
      { t: '2026-06-13 06:00', v: '2.5', type: 'H' }, { t: '2026-06-13 12:00', v: '0.3', type: 'L' },
    ] });
    x.onload();
  };
  const dfoHilo = (x) => {
    x.status = 200;
    x.responseText = JSON.stringify([
      { eventDate: '2026-06-13T06:00:00Z', value: 2.5 }, { eventDate: '2026-06-13T12:00:00Z', value: 0.3 },
    ]);
    x.onload();
  };
  installXhr({
    'nominatim': (x) => { x.status = 200; x.responseText = JSON.stringify([{ lat: 47.6, lon: -122.34 }]); x.onload(); },
    'tidesandcurrents': noaaHilo, // NOAA hilo host
    'dfo-mpo': dfoHilo, 'api-iwls': dfoHilo, // DFO hilo host(s)
  });
  const listeners = setEnv(ls);
  loadIndexFresh();
  // r150 near Seattle selects 4 stations (1 NOAA nearest-first, then DFO).
  assert.doesNotThrow(() => {
    listeners.webviewclosed({ response: regionResponse('Seattle', 150, 45) });
  }, 'a quota failure must not throw');

  const rec = region.read(ls);
  assert.strictEqual(rec.truncated, true, 'region marked truncated on a quota stop');
  assert.ok(rec.stations.length >= 1, 'the stations that fit are kept: ' + rec.stations.length);
  // Exactly the cached stations remain in the record (consistency for serving).
  rec.stations.forEach((s) => {
    assert.ok(blobcache.getBytes(ls, s.id), 'kept station ' + s.id + ' has a cached blob');
  });
  teardown();
});
