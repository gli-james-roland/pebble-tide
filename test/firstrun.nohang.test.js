'use strict';
// Issue #92: after an uninstall+reinstall the watch loses its persisted blob and
// shows "Loading…", but the phone's localStorage (cacheMeta) survives, so
// shouldRefresh() is false and the phone sends nothing -- the watch hangs
// forever. Auto mode must always deliver a blob to the watch on launch (resend
// the phone-cached blob, or re-fetch if none), and surface a reason on the watch
// when it genuinely cannot. These tests drive the real index.js launch glue.
const { test } = require('node:test');
const assert = require('node:assert');
const blob = require('../src/pkjs/blob');
const catalog = require('../src/pkjs/catalog');
const blobcache = require('../src/pkjs/blobcache');

const META_KEY = 'cacheMeta';

function fakeLocalStorage() {
  const m = {};
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
  };
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

// A seed-region-free Auto launch harness. `opts` tunes the environment:
//   geo: 'ok' | 'denied' | 'unavailable'   (default 'ok')
//   xhr: 'blob' | 'fail'                    hilo response (default 'fail')
function runLaunch(ls, opts) {
  opts = opts || {};
  const sent = [];        // every Pebble.sendAppMessage payload
  const listeners = {};
  let xhrCount = 0;
  global.localStorage = ls;
  global.XMLHttpRequest = function () {
    xhrCount++;
    this.open = function () {};
    this.setRequestHeader = function () {};
    this.send = function () {
      const self = this;
      if (opts.xhr === 'blob') {
        // Not exercised in these tests (hilo parsing is provider-specific); the
        // resend path serves cached bytes with no network.
        self.status = 200; self.responseText = '[]';
        if (self.onload) { self.onload(); }
      } else if (self.onerror) {
        self.onerror();
      }
    };
  };
  const geo = opts.geo || 'ok';
  Object.defineProperty(global, 'navigator', {
    value: {
      onLine: true,
      geolocation: {
        getCurrentPosition: (success, failure) => {
          if (geo === 'ok') { success({ coords: { latitude: 49.3, longitude: -123.15 } }); }
          else if (geo === 'denied') { failure({ code: 1, message: 'denied' }); }
          else { failure({ code: 2, message: 'unavailable' }); }
        },
      },
    },
    configurable: true, writable: true,
  });
  global.Pebble = {
    addEventListener: (name, fn) => { listeners[name] = fn; },
    sendAppMessage: (msg, ok) => { sent.push(msg); if (ok) { ok(); } },
    openURL: () => {},
  };

  delete require.cache[require.resolve('../src/pkjs/index.js')];
  require('../src/pkjs/index.js');
  listeners.ready();
  // The watch reports it has no persisted blob (reinstall) once it sees the
  // phone is alive. Fired after ready() to mirror the real handshake order.
  if (opts.requestData && listeners.appmessage) {
    listeners.appmessage({ payload: { WATCH_NEEDS_DATA: 1 } });
  }

  return {
    sent,
    xhrCount,
    chunks: sent.filter((m) => m && m.CHUNK_DATA),
    statuses: sent.filter((m) => m && m.STATUS_TEXT != null).map((m) => m.STATUS_TEXT),
  };
}

function cleanup() {
  delete global.localStorage; delete global.XMLHttpRequest; delete global.Pebble;
}

// A warm Auto launch whose cache is fresh. Returns { ls, station, u8 } so tests
// can drive it with or without the watch's WATCH_NEEDS_DATA request.
function seedFreshWarm(ls) {
  const today = todayStr();
  const station = {
    provider: 'dfo', id: 'STN_X', officialName: 'Ambleside', operating: true,
    latitude: 49.3, longitude: -123.15, region: 'BC', tz: 'America/Vancouver',
  };
  // Fresh catalog slices -> launch runs locate() directly, background refresh
  // finds nothing stale (no network). Slices use the catalog record shape.
  catalog.writeSlice(ls, 'dfo',
    [{ id: station.id, name: station.officialName, lat: station.latitude, lng: station.longitude, provider: 'dfo' }],
    Date.now(), blob.BLOB_VERSION);
  ['noaa', 'bom', 'uk'].forEach((p) => catalog.writeSlice(ls, p, [], Date.now(), blob.BLOB_VERSION));
  // Phone thinks the watch is up to date (same day, station, version)...
  ls.setItem(META_KEY, JSON.stringify({ date: today, stationId: station.id, version: blob.BLOB_VERSION }));
  ls.setItem('lastStation', JSON.stringify({
    id: station.id, officialName: station.officialName, latitude: station.latitude,
    longitude: station.longitude, operating: true, provider: 'dfo', distanceKm: 1,
  }));
  // ...and still holds the blob it sent last time.
  const now = Math.floor(Date.now() / 1000);
  const u8 = blob.packWeek(
    [{ epoch: now - 3600, heightCm: 120, kind: 1 }, { epoch: now + 3600, heightCm: 30, kind: 2 }],
    station, 0, []
  );
  blobcache.setBytes(ls, station.id, u8, today, blob.BLOB_VERSION);
  return { station, u8 };
}

test('warm launch with fresh cache sends nothing to a watch that already has data', () => {
  const ls = fakeLocalStorage();
  seedFreshWarm(ls);
  const r = runLaunch(ls, { geo: 'ok' }); // no WATCH_NEEDS_DATA
  cleanup();
  assert.strictEqual(r.chunks.length, 0, 'no redundant blob resend on a warm launch');
  assert.strictEqual(r.xhrCount, 0, 'and no network');
});

test('reinstalled watch requests data: phone resends the cached blob (no network)', () => {
  const ls = fakeLocalStorage();
  const { u8 } = seedFreshWarm(ls);
  const r = runLaunch(ls, { geo: 'ok', requestData: true });
  cleanup();
  const reassembled = [].concat.apply([], r.chunks.map((m) => m.CHUNK_DATA));
  assert.deepStrictEqual(reassembled, Array.from(u8), 'watch received the cached blob on request');
  assert.strictEqual(r.xhrCount, 0, 'resend must not hit the network');
});

// Seed 4 fresh catalog slices so launch takes the warm path with no background
// catalog network. `dfo` carries one station at the geolocated position.
function seedCatalog(ls) {
  catalog.writeSlice(ls, 'dfo',
    [{ id: 'STN_X', name: 'Ambleside', lat: 49.3, lng: -123.15, provider: 'dfo' }],
    Date.now(), blob.BLOB_VERSION);
  ['noaa', 'bom', 'uk'].forEach((p) => catalog.writeSlice(ls, p, [], Date.now(), blob.BLOB_VERSION));
}

test('hilo download keeps failing and no cached blob: watch gets a download-failed reason', () => {
  const ls = fakeLocalStorage();
  seedCatalog(ls); // no cacheMeta, no cached blob -> shouldRefresh true -> fetch

  const r = runLaunch(ls, { geo: 'ok', xhr: 'fail' });
  cleanup();

  assert.strictEqual(r.chunks.length, 0, 'no blob when every fetch fails');
  assert.ok(r.statuses.indexOf('Tide data download failed') !== -1,
    'watch told the download failed; got: ' + JSON.stringify(r.statuses));
});

test('geolocation permission denied, no remembered station: watch told location is off', () => {
  const ls = fakeLocalStorage(); // cold start, no last station
  const r = runLaunch(ls, { geo: 'denied', xhr: 'fail' });
  cleanup();
  assert.ok(r.statuses.indexOf('Location permission off') !== -1,
    'got: ' + JSON.stringify(r.statuses));
});

test('geolocation unavailable, no remembered station: watch told there is no fix', () => {
  const ls = fakeLocalStorage();
  const r = runLaunch(ls, { geo: 'unavailable', xhr: 'fail' });
  cleanup();
  assert.ok(r.statuses.indexOf('No location fix') !== -1,
    'got: ' + JSON.stringify(r.statuses));
});

test('no station anywhere in the catalog union: watch told no station found', () => {
  const ls = fakeLocalStorage();
  // Every provider covered by an empty slice -> unionStations drops the seed too
  // -> selectStation finds nothing.
  ['dfo', 'noaa', 'bom', 'uk'].forEach((p) => catalog.writeSlice(ls, p, [], Date.now(), blob.BLOB_VERSION));
  const r = runLaunch(ls, { geo: 'ok', xhr: 'fail' });
  cleanup();
  assert.ok(r.statuses.indexOf('No tide station found') !== -1,
    'got: ' + JSON.stringify(r.statuses));
});
