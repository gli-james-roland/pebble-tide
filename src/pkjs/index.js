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
var region = require('./region');
var regionselect = require('./regionselect');
var regionserve = require('./regionserve');
var blobcache = require('./blobcache');
var geocode = require('./geocode');

// #58 tracer: fixed region station cap. The byte-budget-driven cap is #59.
var REGION_CAP = 400;

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

// ---------------------------------------------------------------------------
// Pinned-region offline cache (ADR 0006, issue #58)
// ---------------------------------------------------------------------------

// Download one station's range and store it in the phone blob cache (not sent
// to the watch here -- the launch path serves the nearest cached station).
// distanceKm is baked as 0: the served station is the nearest by construction,
// so the far-distance flag stays off. cb(true) on cache write, cb(false) on a
// failed fetch or a quota write failure.
function downloadStationToCache(station, rangeDays, cb) {
  var now = new Date();
  var from = new Date(now.getTime() - BACK_DAYS * 24 * 60 * 60 * 1000);
  var to = new Date(now.getTime() + rangeDays * 24 * 60 * 60 * 1000);
  var adapter = providers.forStation(station);
  var hiloUrl = adapter.hiloUrl(station, from, to);
  var sunDays = sunDaysForWindow(from, to, station);
  function handle(e1, raw) {
    var points = providers.pointsFor(station, e1, raw);
    if (points.length === 0) { cb(false); return; }
    var u8 = blob.packWeek(points, station, 0, sunDays);
    cb(blobcache.setBytes(localStorage, station.id, u8, todayStr(), blob.BLOB_VERSION));
  }
  if (adapter.responseFormat === 'text') {
    fetchRaw(hiloUrl, adapter.requestHeaders || null, handle);
  } else {
    fetchJson(hiloUrl, handle, adapter.requestHeaders);
  }
}

// Download every station in the region, one at a time (API-polite). #58 has no
// progress UI or byte budget (issues #59/#62); it just caches the set.
function downloadRegion(rec, onDone) {
  var stations = rec.stations || [];
  var i = 0;
  var ok = 0;
  function next() {
    if (i >= stations.length) {
      console.log('Region cached ' + ok + '/' + stations.length + ' stations');
      if (onDone) { onDone(ok); }
      return;
    }
    downloadStationToCache(stations[i++], rec.rangeDays, function (good) {
      if (good) { ok++; }
      next();
    });
  }
  next();
}

// Launch path for a pinned region: GPS -> nearest cached station -> send to the
// watch. Cache-only, no network. No fix -> serve nearest cached to the region
// center (fuller fallback is #63).
function serveRegion(rec) {
  function deliver(served) {
    if (!served) { console.log('Region: no cached station to serve'); return; }
    console.log('Region: serving ' + served.station.officialName + ' from cache');
    writeJson(LAST_STATION_KEY, {
      id: served.station.id, officialName: served.station.officialName,
      latitude: served.station.latitude, longitude: served.station.longitude,
      operating: served.station.operating, provider: served.station.provider,
      tz: served.station.tz, region: served.station.region,
      distanceKm: served.distanceKm,
    });
    sendBlob(served.u8, served.station.id);
  }
  navigator.geolocation.getCurrentPosition(function (pos) {
    deliver(regionserve.pickServe(rec, pos.coords.latitude, pos.coords.longitude, localStorage));
  }, function () {
    var c = rec.center;
    deliver(c ? regionserve.pickServe(rec, c.lat, c.lon, localStorage) : null);
  }, { timeout: 15000, maximumAge: 60000 });
}

Pebble.addEventListener('ready', function () {
  console.log('pebble_tides pkjs ready');
  sendConfig();

  var rec = region.read(localStorage);
  if (rec.mode === 'region') {
    // Region Mode (ADR 0006): serve the nearest cached station, no network.
    // Auto-refresh of the aged window is issue #61.
    console.log('Region pinned: ' + ((rec.stations || []).length) + ' stations');
    serveRegion(rec);
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
  Pebble.openURL(config.pageUrl(region.read(localStorage)));
});

// On save, persist the chosen settings to localStorage then re-send them on the
// config channel so the watch re-renders without refetching. No response = user
// cancelled, leave settings unchanged.
Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) { return; }     // user cancelled
  config.save(e.response);
  sendConfig();

  var loc = region.parseResponse(e.response);
  if (!loc) { return; }

  var cur = region.read(localStorage);

  if (loc.mode === 'auto') {
    // Only act on a real transition out of Region Mode. A display-only save
    // (units/clock) while already in Auto must not trigger an extra geolocation.
    if (cur.mode === 'region') {
      region.clear(localStorage);
      locate();                          // resume Auto immediately
    }
    return;
  }

  // Region. Skip the geocode + re-download when the location is unchanged
  // (e.g. the user only flipped units/clock): same place, same radius, same
  // range, already resolved to a set.
  if (cur.mode === 'region' && cur.stations && cur.stations.length &&
      cur.place === loc.place && cur.radiusKm === loc.radiusKm &&
      cur.rangeDays === loc.rangeDays) {
    return;
  }
  if (!loc.place) {
    region.write(localStorage, { mode: 'region', place: '', center: null, radiusKm: loc.radiusKm, cap: REGION_CAP, stations: [], rangeDays: loc.rangeDays, fetchedAt: null, truncated: false, error: 'No place entered' });
    return;
  }
  // Region: geocode the place, select the nearby stations, download them all.
  geocode.geocode(loc.place, function (coords) {
    if (!coords) {
      region.write(localStorage, { mode: 'region', place: loc.place, center: null, radiusKm: loc.radiusKm, cap: REGION_CAP, stations: [], rangeDays: loc.rangeDays, fetchedAt: null, truncated: false, error: 'Couldn\'t find "' + loc.place + '"' });
      return;
    }
    var cands = catalog.unionStations(catalog.readCache(localStorage), STATIONS);
    var sel = regionselect.selectRegion(cands, coords.lat, coords.lon, loc.radiusKm, REGION_CAP);
    if (sel.stations.length === 0) {
      region.write(localStorage, { mode: 'region', place: loc.place, center: { lat: coords.lat, lon: coords.lon }, radiusKm: loc.radiusKm, cap: REGION_CAP, stations: [], rangeDays: loc.rangeDays, fetchedAt: null, truncated: false, error: 'No stations within ' + loc.radiusKm + ' km of "' + loc.place + '"' });
      return;
    }
    var rec = {
      mode: 'region', place: loc.place, center: { lat: coords.lat, lon: coords.lon },
      radiusKm: loc.radiusKm, cap: REGION_CAP, stations: sel.stations,
      rangeDays: loc.rangeDays, fetchedAt: todayStr(), truncated: sel.truncated, error: null,
    };
    region.write(localStorage, rec);
    downloadRegion(rec, null);
  });
});
