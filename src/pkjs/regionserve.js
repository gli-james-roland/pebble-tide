'use strict';

// The offline serve decision for a pinned region (ADR 0006). Given the region
// record, the current GPS position, and storage, pick the nearest station that
// has a cached blob and return it with its bytes. This reads ONLY the phone
// cache -- it takes no fetcher and never touches the network, which is what
// makes an offline launch a zero-request path. Returns null if no cached
// station is available (caller falls back).
//
// "Nearest cached" (not just nearest) means a partially downloaded region still
// serves: if the closest station's blob is missing, the next closest with a
// blob wins.

var geo = require('./geo');
var blobcache = require('./blobcache');

function pickServe(region, lat, lon, storage) {
  var stations = (region && region.stations) || [];
  var best = null;
  var bestKm = Infinity;
  var bestBytes = null;
  for (var i = 0; i < stations.length; i++) {
    var s = stations[i];
    var km = geo.haversineKm(lat, lon, s.latitude, s.longitude);
    if (km >= bestKm) { continue; }
    var cached = blobcache.getBytes(storage, s.id);
    if (!cached) { continue; }
    best = s;
    bestKm = km;
    bestBytes = cached.u8;
  }
  if (!best) { return null; }
  return { station: best, distanceKm: bestKm, u8: bestBytes };
}

// Offline-launch fallback (#63, case 3). No GPS fix, so we don't know where the
// user is. Try the LAST-SERVED station's coords first (most likely still near
// the user, and it keeps the same station stable across offline relaunches),
// then the region center, then give up. Cache-only -- each attempt is a
// pickServe over the phone cache, no network. `last` is the LAST_STATION_KEY
// record ({ latitude, longitude, ... }) or null.
function serveNoFix(region, last, storage) {
  if (last && typeof last.latitude === 'number' && typeof last.longitude === 'number') {
    var byLast = pickServe(region, last.latitude, last.longitude, storage);
    if (byLast) { return byLast; }
  }
  var c = region && region.center;
  if (c) {
    var byCenter = pickServe(region, c.lat, c.lon, storage);
    if (byCenter) { return byCenter; }
  }
  return null;
}

module.exports = { pickServe: pickServe, serveNoFix: serveNoFix };
