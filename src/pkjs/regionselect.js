'use strict';

// Choose the stations a pinned region caches (ADR 0006). Given the candidate
// union (catalog.unionStations), a center, a radius, and a station cap, return
// the operating stations within the radius, nearest-first, clipped to the cap.
//
// #58 caps by station count only. The byte budget (#59) layers on top of this
// same nearest-first ordering, so a truncated region always keeps the closest
// stations either way.

var geo = require('./geo');

// #59 storage bounds (ADR 0007). Selection caps by station count; the download
// loop enforces the running byte total because real blob sizes are only known
// after packing. Both are exported so index.js shares one source of truth.
var MAX_STATIONS = 400;          // hard station cap (~1.8 MB at ~4.5 KB/blob)
var REGION_BYTE_BUDGET = 2500000; // ~2.5 MB of base64 blob bytes

// Pure stop decision for the download loop: true means caching a station of
// addBytes keeps the cumulative total (usedBytes) at or under the budget.
// Measured in base64 length, which is what blobcache actually stores.
function withinBudget(usedBytes, addBytes, budget) {
  return usedBytes + addBytes <= budget;
}

function selectRegion(candidates, lat, lon, radiusKm, cap) {
  var within = [];
  for (var i = 0; i < candidates.length; i++) {
    var s = candidates[i];
    if (!s.operating) { continue; }
    var km = geo.haversineKm(lat, lon, s.latitude, s.longitude);
    if (km <= radiusKm) {
      within.push({ station: s, km: km });
    }
  }
  within.sort(function (a, b) { return a.km - b.km; });
  var truncated = within.length > cap;
  var kept = within.slice(0, cap).map(function (w) { return w.station; });
  return { stations: kept, truncated: truncated };
}

module.exports = {
  selectRegion: selectRegion,
  withinBudget: withinBudget,
  MAX_STATIONS: MAX_STATIONS,
  REGION_BYTE_BUDGET: REGION_BYTE_BUDGET,
};
