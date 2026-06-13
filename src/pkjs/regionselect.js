'use strict';

// Choose the stations a pinned region caches (ADR 0006). Given the candidate
// union (catalog.unionStations), a center, a radius, and a station cap, return
// the operating stations within the radius, nearest-first, clipped to the cap.
//
// #58 caps by station count only. The byte budget (#59) layers on top of this
// same nearest-first ordering, so a truncated region always keeps the closest
// stations either way.

var geo = require('./geo');

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

module.exports = { selectRegion: selectRegion };
