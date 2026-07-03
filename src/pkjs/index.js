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

// Region storage bounds (#58/#59, ADR 0007). The station cap clips selection;
// the byte budget stops the download loop once cumulative blob bytes would
// exceed it. Both live in regionselect so selection and download agree.
var REGION_CAP = regionselect.MAX_STATIONS;
var REGION_BYTE_BUDGET = regionselect.REGION_BYTE_BUDGET;

var CATALOG_PROVIDERS = ['dfo', 'noaa', 'bom', 'uk'];

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

// Tell the watch WHY it has no tides yet (#92). The watch shows this in place of
// "Loading…" only while it holds no tide data, so it never clobbers a good blob.
function sendStatus(text) {
  console.log('Status to watch: ' + text);
  Pebble.sendAppMessage({ STATUS_TEXT: text },
    function () {},
    function (e) { console.log('Status send failed: ' + JSON.stringify(e)); });
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

var MAX_FETCH_ATTEMPTS = 3; // one initial try + 2 retries before giving up (#92)

function fetchRange(station, distanceKm, forwardDays, attempt) {
  attempt = attempt || 1;
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
      if (attempt < MAX_FETCH_ATTEMPTS) {
        console.log('hilo fetch failed (' + e1 + '); retry ' + (attempt + 1) + '/' + MAX_FETCH_ATTEMPTS);
        fetchRange(station, distanceKm, forwardDays, attempt + 1);
        return;
      }
      // Out of retries. A watch that already has data ignores this (it only
      // shows STATUS_TEXT while empty), so a failed daily refresh never clobbers
      // yesterday's cache; a fresh install with no data finally sees a reason.
      console.log('hilo fetch failed (' + e1 + ') after ' + MAX_FETCH_ATTEMPTS + ' tries');
      sendStatus('Tide data download failed');
      return;
    }
    var u8 = blob.packWeek(points, station, distanceKm, sunDays);
    // Cache the blob on the phone too (not just META), so a later launch whose
    // data is "fresh" can re-send it to a watch that lost its persisted copy
    // (reinstall wipes the watch, not the phone's localStorage -- #92).
    blobcache.setBytes(localStorage, station.id, u8, todayStr(), blob.BLOB_VERSION);
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
    // Fresh: skip the network AND the resend. The watch already has this data
    // persisted; if it doesn't (reinstall, #92), it asks via WATCH_NEEDS_DATA
    // and serveWatchRequest re-sends the phone-cached blob. No wasted send on
    // the common warm launch.
    console.log('Cache is fresh for ' + station.officialName + '; not fetching');
  }
}

// Handshake for the reinstall/desync case (#92). On boot a watch with no
// persisted blob sends WATCH_NEEDS_DATA; the phone's record may say "fresh" and
// so send nothing, leaving the watch on "Loading…" forever. Here we deliver from
// the phone cache (no network) if we can, else fetch. Only fires when the watch
// actually lacks data, so warm launches stay send-free.
function serveWatchRequest() {
  var rec = region.read(localStorage);
  if (rec.mode === 'region') {
    console.log('Watch needs data; serving pinned region from cache');
    serveRegion(rec);
    return;
  }
  var last = readJson(LAST_STATION_KEY);
  if (!last) {
    // No remembered station yet: the launch's own locate() path will deliver
    // (or report a reason), so nothing to do here.
    console.log('Watch needs data but no remembered station; launch flow will deliver');
    return;
  }
  var cached = blobcache.getBytes(localStorage, last.id);
  if (cached && cached.version === blob.BLOB_VERSION) {
    console.log('Watch needs data; resending cached blob for ' + last.officialName);
    sendBlob(cached.u8, last.id);
  } else {
    console.log('Watch needs data; no phone blob, fetching for ' + last.officialName);
    fetchRange(last, last.distanceKm || 0, WEEK_DAYS);
  }
}

// Run nearest-by-haversine over the UNION of every cached catalog slice plus
// the seed (seed fills providers that have no cache slice yet). Issue #33.
function selectStation(lat, lon) {
  var candidates = catalog.unionStations(catalog.readCache(localStorage), STATIONS);
  return geo.nearestUsableStation(candidates, lat, lon);
}

// Fetch + parse one provider's catalog. Hands the callback a slice-result the
// pure orchestrate.mergeRefreshResults understands: { ok:true, stations,
// fetchedAt, version } on success, { ok:false } on any failure. Callback-based
// (not Promise): the on-device PebbleKit JS runtime is ES5-style and has no
// Promise, so a Promise here throws on the watch and hangs the launch (#90).
// A failed fetch is isolated to that provider, never propagated.
function fetchCatalogSlice(name, done) {
  var adapter = providers.REGISTRY[name];
  fetchJson(adapter.catalogUrl(), function (err, json) {
    if (err) {
      console.log(name + ' catalog fetch failed (' + err + '); keeping last-good');
      done({ ok: false });
      return;
    }
    try {
      done({
        ok: true,
        stations: adapter.parseCatalog(json),
        fetchedAt: Date.now(),
        version: blob.BLOB_VERSION,
      });
    } catch (e) {
      console.log(name + ' catalog parse failed (' + e + '); keeping last-good');
      done({ ok: false });
    }
  }, adapter.requestHeaders);
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
    fetchCatalogSlice(name, function (result) { persistRefresh(name, result); });
  });
}

// Cold first run (no cache): await EVERY catalog fetch, persist whatever
// succeeded, then run the geolocation->select flow over the resulting union.
// If all fail (offline), the union falls back to the seed so the watch still
// shows a station (far-flag handled by blob). Always proceeds to select.
// Callback fan-in, not Promise.all: the on-device runtime has no Promise (#90).
// finish() runs exactly once, after the last slice lands.
function coldStartThenLocate() {
  var slices = new Array(CATALOG_PROVIDERS.length);
  var pending = CATALOG_PROVIDERS.length;
  var settled = false;
  function finish() {
    if (settled) { return; }
    settled = true;
    CATALOG_PROVIDERS.forEach(function (name, i) { persistRefresh(name, slices[i]); });
    locate();
  }
  if (pending === 0) { finish(); return; }
  CATALOG_PROVIDERS.forEach(function (name, i) {
    fetchCatalogSlice(name, function (result) {
      slices[i] = result;
      pending -= 1;
      if (pending === 0) { finish(); }
    });
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
    sendStatus('No tide station found');
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
    return;
  }
  // No fix and no station to fall back on -> the watch would hang. Tell it why.
  // code 1 === PERMISSION_DENIED (W3C geolocation); 2/3 are unavailable/timeout.
  console.log('No location and no remembered station');
  sendStatus(err && err.code === 1 ? 'Location permission off' : 'No location fix');
}

// ---------------------------------------------------------------------------
// Pinned-region offline cache (ADR 0006, issue #58)
// ---------------------------------------------------------------------------

// Download one station's range and store it in the phone blob cache (not sent
// to the watch here -- the launch path serves the nearest cached station).
// distanceKm is baked as 0: the served station is the nearest by construction,
// so the far-distance flag stays off. cb(true) on cache write, cb(false) on a
// failed fetch or a quota write failure.
// cb(good, bytes, overBudget). bytes is the base64 length the blob would (or
// did) occupy in the cache; overBudget is true when `gate` rejected the write
// because caching it would exceed the region byte budget (#59). gate(bytes) is
// optional -- when omitted the blob is always written.
function downloadStationToCache(station, rangeDays, cb, gate) {
  var now = new Date();
  var from = new Date(now.getTime() - BACK_DAYS * 24 * 60 * 60 * 1000);
  var to = new Date(now.getTime() + rangeDays * 24 * 60 * 60 * 1000);
  var adapter = providers.forStation(station);
  var hiloUrl = adapter.hiloUrl(station, from, to);
  var sunDays = sunDaysForWindow(from, to, station);
  function handle(e1, raw) {
    var points = providers.pointsFor(station, e1, raw);
    if (points.length === 0) { cb(false, 0, false); return; }
    var u8 = blob.packWeek(points, station, 0, sunDays);
    var b64 = blobcache.encode(u8);          // encode once: gate, then store it
    var bytes = b64.length;                   // base64 length = stored size
    if (gate && !gate(bytes)) { cb(false, bytes, true); return; } // budget stop
    cb(blobcache.setB64(localStorage, station.id, b64, todayStr(), blob.BLOB_VERSION), bytes, false);
  }
  if (adapter.responseFormat === 'text') {
    fetchRaw(hiloUrl, adapter.requestHeaders || null, handle);
  } else {
    fetchJson(hiloUrl, handle, adapter.requestHeaders);
  }
}

// Station ids in a region record (authoritative list for blob eviction).
function regionIds(rec) {
  return (rec && rec.stations ? rec.stations : []).map(function (st) { return st.id; });
}

// Download the region's stations one at a time (API-polite), nearest-first,
// enforcing the byte budget (#59). Before each blob is written, withinBudget
// gates it against the cumulative base64 bytes already cached; the first blob
// that would push the total over REGION_BYTE_BUDGET stops the loop without
// being written. A blobcache quota failure (setBytes -> false) stops it too.
// Either way the region is marked truncated and rec.stations is rewritten to
// exactly the stations that landed in the cache, so eviction and serving stay
// consistent (stations beyond the stop are dropped from the record and any of
// their stale blobs from a prior round are evicted).
function downloadRegion(rec, onDone) {
  var stations = rec.stations || [];
  var origIds = regionIds(rec);
  var cached = [];     // stations actually written, nearest-first
  var usedBytes = 0;
  var stopped = false; // budget or quota stop
  var i = 0;
  function finish() {
    // Only a budget/quota stop truncates. A transient per-station fetch failure
    // is not truncation (matches #58): the record keeps its full station list so
    // the next refresh round can retry the stations that failed this time.
    if (stopped) {
      rec.stations = cached;
      rec.truncated = true;
      blobcache.evict(localStorage, origIds, regionIds(rec)); // drop dropped blobs
      region.write(localStorage, rec);
    }
    console.log('Region cached ' + cached.length + '/' + stations.length +
      ' stations (' + usedBytes + ' b64 bytes' + (stopped ? ', truncated' : '') + ')');
    if (onDone) { onDone(cached.length); }
  }
  function next() {
    if (stopped || i >= stations.length) { finish(); return; }
    var station = stations[i++];
    downloadStationToCache(station, rec.rangeDays, function (good, bytes, overBudget) {
      if (overBudget) {            // budget gate refused the write
        stopped = true;
        console.log('Region byte budget reached; stopping at ' + cached.length + ' stations');
      } else if (good) {
        usedBytes += bytes;
        cached.push(station);
      } else if (bytes > 0) {      // packed but setBytes failed -> quota stop
        stopped = true;
        console.log('Region blob write failed (quota); stopping at ' + cached.length + ' stations');
      }
      // good === false with bytes === 0 is a transient fetch failure: skip this
      // station and keep going (mirrors #58 behaviour), not a truncation.
      next();
    }, function (bytes) { return regionselect.withinBudget(usedBytes, bytes, REGION_BYTE_BUDGET); });
  }
  next();
}

// Background window-extend (#61). On an online launch, if the region's window
// has aged past the staleness threshold, re-download the whole region to push
// the 45-day horizon forward. Fire-and-forget: it never blocks serving the
// current nearest cached station. fetchedAt is only bumped after a round
// finishes, so an offline launch (every fetch fails, downloadStationToCache
// keeps the old cache) leaves the region record untouched.
function maybeRefreshRegion(rec) {
  // "Only when online": skip when the browser explicitly reports offline.
  // When navigator.onLine is unavailable or true, attempt -- a real offline
  // launch's fetches just fail and the cache is preserved.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return;
  }
  if (!refresh.regionNeedsRefresh(rec.fetchedAt, todayStr(), rec.rangeDays)) {
    return;
  }
  console.log('Region window aged; background re-download to extend');
  // Re-select the full intended set from the current catalog union rather than
  // re-using rec.stations: a prior round may have truncated rec.stations to the
  // bytes that fit, and feeding that shrunken list back would let the region
  // only ever shrink. Selection is nearest-first and capped, so we always start
  // from the closest REGION_CAP stations around the saved center (#59).
  var cands = catalog.unionStations(catalog.readCache(localStorage), STATIONS);
  var c = rec.center;
  if (c) {
    var sel = regionselect.selectRegion(cands, c.lat, c.lon, rec.radiusKm, REGION_CAP);
    if (sel.stations.length) {
      rec.stations = sel.stations;
      rec.truncated = sel.truncated; // reset; downloadRegion re-sets on a byte stop
    }
  }
  downloadRegion(rec, function () {
    // downloadRegion already persisted rec (with the cached subset + truncated)
    // if a byte/quota stop fired. Bump the window only when the full intended
    // set landed -- a truncated round leaves fetchedAt stale so the next aged
    // launch retries the full set (it may fit once storage frees up).
    if (rec.truncated) {
      console.log('Region round truncated; leaving fetchedAt stale to retry full set');
      return;
    }
    rec.fetchedAt = todayStr();
    region.write(localStorage, rec);
    console.log('Region window extended; fetchedAt=' + rec.fetchedAt);
  });
}

// Launch path for a pinned region: GPS -> nearest cached station -> send to the
// watch. Cache-only, no network. No fix -> serveNoFix fallback chain:
// last-served station first, then region center (#63 case 3).
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
    // No GPS fix (denied/unavailable, #63 case 3). Fall back cache-only: serve
    // nearest the LAST-SERVED station first, else nearest the region center.
    deliver(regionserve.serveNoFix(rec, readJson(LAST_STATION_KEY), localStorage));
  }, { timeout: 15000, maximumAge: 60000 });
}

Pebble.addEventListener('ready', function () {
  console.log('pebble_tides pkjs ready');
  sendConfig();

  var rec = region.read(localStorage);
  if (rec.mode === 'region') {
    // Region Mode (ADR 0006): serve the nearest cached station from cache, then
    // extend the aged window in the background when online (#61).
    console.log('Region pinned: ' + ((rec.stations || []).length) + ' stations');
    serveRegion(rec);
    maybeRefreshRegion(rec);  // #61: extend the aged window in the background
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

// The watch reports (on boot, once it sees the phone is alive) that it has no
// tide data. Deliver some now -- from cache if possible (#92 reinstall desync).
Pebble.addEventListener('appmessage', function (e) {
  if (e && e.payload && e.payload.WATCH_NEEDS_DATA) {
    console.log('Watch requested data (no persisted blob)');
    serveWatchRequest();
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
      blobcache.evict(localStorage, regionIds(cur), []); // drop all region blobs
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
  geocode.geocode(loc.place, function (coords, reason) {
    if (!coords) {
      // #63 case 2: an offline pin must say so, not read as "Couldn't find".
      var msg = reason === 'offline'
        ? 'Connect to the internet to download "' + loc.place + '"'
        : 'Couldn\'t find "' + loc.place + '"';
      region.write(localStorage, { mode: 'region', place: loc.place, center: null, radiusKm: loc.radiusKm, cap: REGION_CAP, stations: [], rangeDays: loc.rangeDays, fetchedAt: null, truncated: false, error: msg });
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
    blobcache.evict(localStorage, regionIds(cur), regionIds(rec)); // drop orphaned blobs
    region.write(localStorage, rec);
    downloadRegion(rec, null);
  });
});
