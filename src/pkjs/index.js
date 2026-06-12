'use strict';

var config = require('./config');
var geo = require('./geo');
var blob = require('./blob');
var refresh = require('./refresh');
var sun = require('./sun');
var providers = require('./providers');
var catalog = require('./catalog');
var orchestrate = require('./orchestrate');
var STATIONS = require('./stations');
var pin = require('./pin');
var geocode = require('./geocode');

var CATALOG_PROVIDERS = ['dfo', 'noaa', 'bom'];

// Issue #9: phone-side display config. Two settings — height units (feet/metres)
// and clock format (12h/24h) — sync to the watch on their own AppMessage
// channel, fully independent of the tide blob. The watch persists them and
// re-renders without refetching. pebble-clay can't build for this app's gabbro
// and flint targets (Clay ships no prebuilt lib for them), so this is a
// hand-rolled showConfiguration page (config.js) + webviewclosed JSON parse.
//   CONFIG_UNITS: 0 = feet (default), 1 = metres
//   CONFIG_CLOCK: 0 = 12-hour AM/PM (default), 1 = 24-hour

function sendConfig() {
  var s = config.read();
  Pebble.sendAppMessage(
    { CONFIG_UNITS: s.units, CONFIG_CLOCK: s.clock, CONFIG_MIDTIDE: s.midtide },
    function () { console.log('Config sent to watch'); },
    function (e) { console.log('Config send failed: ' + JSON.stringify(e)); }
  );
}

// Issue #3: fetch a full week of high/low extrema, pack into a versioned blob,
// and stream it to the watch in chunks. Refresh only on a new calendar day or
// a changed nearest station. The watch persists the blob and works offline.
var WEEK_DAYS = 7;
var BACK_DAYS = 1; // also pull one day of history so the centered window
                   // always has curve to the left of "now"
var CHUNK_SIZE = 64; // bytes per AppMessage; must match CHUNK_SIZE on the watch
var META_KEY = 'cacheMeta';
var LAST_STATION_KEY = 'lastStation';

function todayStr() {
  var d = new Date();
  var m = ('0' + (d.getMonth() + 1)).slice(-2);
  var day = ('0' + d.getDate()).slice(-2);
  return d.getFullYear() + '-' + m + '-' + day;
}

// Low-level GET. headers is an optional { name: value } map applied after open()
// (BOM needs a browser User-Agent or it returns "Access Denied"). Hands back the
// raw responseText so text providers (BOM HTML) and JSON providers share one path.
function fetchRaw(url, headers, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', url, true);
  xhr.timeout = 20000;
  if (headers) {
    Object.keys(headers).forEach(function (name) {
      try {
        xhr.setRequestHeader(name, headers[name]);
      } catch (e) { /* a forbidden header must not kill the request */ }
    });
  }
  xhr.onload = function () {
    if (xhr.status < 200 || xhr.status >= 300) {
      cb('status ' + xhr.status, null);
      return;
    }
    cb(null, xhr.responseText);
  };
  xhr.onerror = function () { cb('network error', null); };
  xhr.ontimeout = function () { cb('timeout', null); };
  xhr.send();
}

function fetchJson(url, cb, headers) {
  fetchRaw(url, headers || null, function (err, text) {
    if (err) {
      cb(err, null);
      return;
    }
    try {
      cb(null, JSON.parse(text));
    } catch (e) {
      cb('parse: ' + e, null);
    }
  });
}

function readJson(key) {
  try {
    var raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) { /* localStorage may be unavailable; non-fatal */ }
}

function sendBlob(u8, stationId, onDone) {
  var chunks = blob.chunkBytes(u8, CHUNK_SIZE);
  var total = chunks.length;
  function sendChunk(i) {
    if (i >= total) {
      console.log('Blob sent: ' + total + ' chunks, ' + u8.length + ' bytes');
      if (onDone) { onDone(); }
      return;
    }
    Pebble.sendAppMessage({
      CHUNK_INDEX: i,
      CHUNK_TOTAL: total,
      CHUNK_DATA: Array.prototype.slice.call(chunks[i]),
    }, function () {
      sendChunk(i + 1); // ACK received -> send the next chunk
    }, function (e) {
      console.log('Chunk ' + i + ' failed: ' + JSON.stringify(e));
    });
  }
  sendChunk(0);
}

// One sunrise/sunset per UTC day spanning the fetch window, computed from the
// station's coordinates (issue #8). The watch shades the night columns from
// these, fully offline.
function sunDaysForWindow(from, to, station) {
  var DAY_MS = 24 * 60 * 60 * 1000;
  var days = [];
  var dayStart = Math.floor(from.getTime() / DAY_MS) * DAY_MS;
  for (var t = dayStart; t <= to.getTime(); t += DAY_MS) {
    days.push(sun.sunTimes(t, station.latitude, station.longitude));
  }
  return days;
}

function fetchRange(station, distanceKm, forwardDays) {
  var now = new Date();
  var from = new Date(now.getTime() - BACK_DAYS * 24 * 60 * 60 * 1000);
  var to = new Date(now.getTime() + forwardDays * 24 * 60 * 60 * 1000);
  var adapter = providers.forStation(station);
  var hiloUrl = adapter.hiloUrl(station, from, to);
  var sunDays = sunDaysForWindow(from, to, station);

  // The watch draws a cosine curve between extrema (ADR 0002), so we only need
  // the high/low series. pointsFor routes by provider and owns the response
  // shape (DFO array, NOAA object, BOM HTML string).
  function handle(e1, raw) {
    var points = providers.pointsFor(station, e1, raw);
    if (points.length === 0) {
      console.log('hilo fetch failed (' + e1 + '); keeping cache');
      return;
    }
    var u8 = blob.packWeek(points, station, distanceKm, sunDays);
    sendBlob(u8, station.id, function () {
      writeJson(META_KEY, { date: todayStr(), stationId: station.id, version: blob.BLOB_VERSION });
    });
  }

  if (adapter.responseFormat === 'text') {
    fetchRaw(hiloUrl, adapter.requestHeaders || null, handle);
  } else {
    fetchJson(hiloUrl, handle, adapter.requestHeaders);
  }
}

function fetchWeek(station, distanceKm) {
  fetchRange(station, distanceKm, WEEK_DAYS);
}

function maybeRefresh(station, distanceKm, forwardDays) {
  var days = forwardDays || WEEK_DAYS;
  if (refresh.shouldRefresh(todayStr(), station.id, blob.BLOB_VERSION, readJson(META_KEY))) {
    console.log('Refreshing ' + days + ' days for ' + station.officialName);
    fetchRange(station, distanceKm, days);
  } else {
    console.log('Cache is fresh for ' + station.officialName + '; not fetching');
  }
}

// Run nearest-by-haversine over the UNION of every cached catalog slice plus
// the seed (seed fills providers that have no cache slice yet). Issue #33.
function selectStation(lat, lon) {
  var candidates = catalog.unionStations(catalog.readCache(localStorage), STATIONS);
  return geo.nearestUsableStation(candidates, lat, lon);
}

// Fetch + parse one provider's catalog. Resolves to a slice-result the pure
// orchestrate.mergeRefreshResults understands: { ok:true, stations, fetchedAt,
// version } on success, { ok:false } on any failure. Never rejects — a failed
// fetch is isolated to that provider, not propagated.
function fetchCatalogSlice(name) {
  return new Promise(function (resolve) {
    var adapter = providers.REGISTRY[name];
    fetchJson(adapter.catalogUrl(), function (err, json) {
      if (err) {
        console.log(name + ' catalog fetch failed (' + err + '); keeping last-good');
        resolve({ ok: false });
        return;
      }
      try {
        resolve({
          ok: true,
          stations: adapter.parseCatalog(json),
          fetchedAt: Date.now(),
          version: blob.BLOB_VERSION,
        });
      } catch (e) {
        console.log(name + ' catalog parse failed (' + e + '); keeping last-good');
        resolve({ ok: false });
      }
    }, adapter.requestHeaders);
  });
}

// Persist whatever a refresh round produced, with per-provider failure
// isolation handled by the pure merge (a failed provider keeps its old slice).
function persistRefresh(provider, result) {
  if (result && result.ok) {
    catalog.writeSlice(localStorage, provider, result.stations, result.fetchedAt, result.version);
    console.log(provider + ' catalog cached (' + result.stations.length + ' stations)');
  }
}

// Background refresh for the providers whose slice is stale or version-bumped.
// Fire-and-forget: it writes slices for the NEXT launch and never blocks this
// one. Each provider is isolated — one failure does not affect the other.
function backgroundRefreshCatalogs(cache) {
  var stale = orchestrate.providersToRefresh(
    cache, Date.now(), orchestrate.CATALOG_TTL_MS, blob.BLOB_VERSION, CATALOG_PROVIDERS
  );
  if (stale.length === 0) {
    return;
  }
  console.log('Background catalog refresh: ' + stale.join(', '));
  stale.forEach(function (name) {
    fetchCatalogSlice(name).then(function (result) { persistRefresh(name, result); });
  });
}

// Cold first run (no cache): await BOTH catalog fetches, persist whatever
// succeeded, then run the geolocation->select flow over the resulting union.
// If both fail (offline), the union falls back to the seed so the watch still
// shows a station (far-flag handled by blob). Always proceeds to select.
function coldStartThenLocate() {
  Promise.all(CATALOG_PROVIDERS.map(fetchCatalogSlice)).then(function (slices) {
    CATALOG_PROVIDERS.forEach(function (name, i) { persistRefresh(name, slices[i]); });
    locate();
  });
}

function locate() {
  navigator.geolocation.getCurrentPosition(onPosition, onPositionError, {
    timeout: 15000,
    maximumAge: 60000,
  });
}

function onPosition(pos) {
  var result = selectStation(pos.coords.latitude, pos.coords.longitude);
  if (!result) {
    console.log('No usable station found');
    return;
  }
  writeJson(LAST_STATION_KEY, {
    id: result.station.id, officialName: result.station.officialName,
    latitude: result.station.latitude, longitude: result.station.longitude,
    operating: result.station.operating, provider: result.station.provider,
    tz: result.station.tz, region: result.station.region,
    distanceKm: result.distanceKm,
  });
  maybeRefresh(result.station, result.distanceKm);
}

function onPositionError(err) {
  console.log('Geolocation failed (' + err.code + '): ' + err.message);
  var last = readJson(LAST_STATION_KEY);
  if (last) {
    console.log('Falling back to last station: ' + last.officialName);
    maybeRefresh(last, last.distanceKm || 0);
  } else {
    console.log('No location and no remembered station');
  }
}

Pebble.addEventListener('ready', function () {
  console.log('pebble_tides pkjs ready');
  sendConfig();

  var p = pin.read(localStorage);
  if (p.mode === 'pinned' && p.station) {
    // Pinned Mode (ADR 0004/0005): no geolocation. Refresh the pinned station's
    // range when online; fetchRange keeps the stored snapshot on failure (offline).
    console.log('Pinned to ' + p.station.officialName + ' (' + p.rangeDays + 'd)');
    maybeRefresh(p.station, p.distanceKm || 0, p.rangeDays);
    return;
  }

  var cache = catalog.readCache(localStorage);
  if (!orchestrate.hasAnyCache(cache)) {
    // Cold first run: await catalog fetch(es) so an out-of-seed-region user gets
    // a correct nearby station on the very first launch (offline -> seed fallback).
    coldStartThenLocate();
  } else {
    // Cache present: select instantly from the union; refresh stale/bumped
    // slices in the background for next launch (does not block this display).
    locate();
    backgroundRefreshCatalogs(cache);
  }
});

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(config.pageUrl(pin.read(localStorage)));
});

// On save, persist the chosen settings to localStorage then re-send them on the
// config channel so the watch re-renders without refetching. No response = user
// cancelled, leave settings unchanged.
Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) { return; }     // user cancelled
  config.save(e.response);
  sendConfig();

  var loc = pin.parseResponse(e.response);
  if (!loc) { return; }

  if (loc.mode === 'auto') {
    pin.clear(localStorage);
    locate();                            // resume Auto immediately
    return;
  }
  if (!loc.place) {
    pin.write(localStorage, { mode: 'pinned', place: '', station: null, rangeDays: loc.rangeDays, distanceKm: 0, error: 'No place entered' });
    return;
  }
  // Pinned: geocode the place, pick the nearest Usable Station, download the range.
  geocode.geocode(loc.place, function (coords) {
    if (!coords) {
      pin.write(localStorage, { mode: 'pinned', place: loc.place, station: null, rangeDays: loc.rangeDays, distanceKm: 0, error: 'Couldn\'t find "' + loc.place + '"' });
      return;
    }
    var result = selectStation(coords.lat, coords.lon);
    if (!result) {
      pin.write(localStorage, { mode: 'pinned', place: loc.place, station: null, rangeDays: loc.rangeDays, distanceKm: 0, error: 'No station found near "' + loc.place + '"' });
      return;
    }
    var st = result.station;
    pin.write(localStorage, {
      mode: 'pinned', place: loc.place, rangeDays: loc.rangeDays, distanceKm: result.distanceKm, error: null,
      station: { id: st.id, officialName: st.officialName, latitude: st.latitude, longitude: st.longitude, operating: st.operating, provider: st.provider, tz: st.tz, region: st.region },
    });
    fetchRange(st, result.distanceKm, loc.rangeDays);
  });
});
