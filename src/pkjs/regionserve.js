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

module.exports = { pickServe: pickServe };
