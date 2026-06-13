'use strict';
// Integration test for the real index.js launch glue: a pinned region with a
// cached blob must serve the nearest station to the watch on launch WITHOUT any
// network request. Stubs the PebbleKit JS globals (Pebble, XMLHttpRequest,
// navigator, localStorage) so index.js runs under node.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const blob = require('../src/pkjs/blob');
const region = require('../src/pkjs/region');
const blobcache = require('../src/pkjs/blobcache');

function fakeLocalStorage() {
  const m = {};
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
  };
}

test('offline launch with a pinned region serves the cached station and makes zero network calls', () => {
  const ls = fakeLocalStorage();

  // Seed a region with one station and a valid cached blob for it.
  const now = Math.floor(Date.now() / 1000);
  const station = { id: 'STN_A', officialName: 'Test Harbour', latitude: 47.6, longitude: -122.3, operating: true, provider: 'noaa' };
  const points = [
    { epoch: now - 3600, heightCm: 120, kind: 1 },
    { epoch: now + 3600, heightCm: 30, kind: 2 },
    { epoch: now + 7200, heightCm: 110, kind: 1 },
  ];
  const u8 = blob.packWeek(points, station, 0, []);
  blobcache.setBytes(ls, station.id, u8, '2026-06-13', blob.BLOB_VERSION);
  region.write(ls, {
    mode: 'region', place: 'Seattle', center: { lat: 47.6, lon: -122.3 },
    radiusKm: 75, cap: 400, stations: [station], rangeDays: 45,
    fetchedAt: '2026-06-13', truncated: false, error: null,
  });

  // Stub the PebbleKit JS environment.
  let xhrConstructed = 0;
  const listeners = {};
  const sentChunks = [];
  global.localStorage = ls;
  global.XMLHttpRequest = function () { xhrConstructed++; }; // any network use trips this
  // navigator is a read-only built-in in modern node, so define over it.
  Object.defineProperty(global, 'navigator', {
    value: { geolocation: { getCurrentPosition: (success) => success({ coords: { latitude: 47.61, longitude: -122.31 } }) } },
    configurable: true, writable: true,
  });
  global.Pebble = {
    addEventListener: (name, fn) => { listeners[name] = fn; },
    sendAppMessage: (msg, ok) => {
      if (msg && msg.CHUNK_DATA) { sentChunks.push(msg.CHUNK_DATA); }
      if (ok) { ok(); } // ACK so sendBlob advances through every chunk
    },
  };

  // Load index.js fresh so its module-load addEventListener calls register here.
  delete require.cache[require.resolve('../src/pkjs/index.js')];
  require('../src/pkjs/index.js');

  // Fire the launch.
  listeners.ready();

  // The cached blob was chunked and sent to the watch...
  const reassembled = [].concat.apply([], sentChunks);
  assert.deepStrictEqual(reassembled, Array.from(u8), 'watch received the cached blob bytes');
  // ...and nothing hit the network.
  assert.strictEqual(xhrConstructed, 0, 'offline serve path must not construct an XMLHttpRequest');

  delete global.localStorage; delete global.XMLHttpRequest; delete global.Pebble;
});
