'use strict';

// Station selection: great-circle distance and nearest Usable Station.
// Ported from docs/example.py's haversine. See CONTEXT.md (Usable Station).

var EARTH_RADIUS_KM = 6371.0;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  var dPhi = toRad(lat2 - lat1);
  var dLambda = toRad(lon2 - lon1);
  var a = Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLambda / 2) * Math.sin(dLambda / 2);
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nearestUsableStation(stations, lat, lon) {
  var best = null;
  var bestKm = Infinity;
  for (var i = 0; i < stations.length; i++) {
    var s = stations[i];
    if (!s.operating) {
      continue;
    }
    var km = haversineKm(lat, lon, s.latitude, s.longitude);
    if (km < bestKm) {
      bestKm = km;
      best = s;
    }
  }
  if (!best) {
    return null;
  }
  return { station: best, distanceKm: bestKm };
}

module.exports = { haversineKm, nearestUsableStation };
