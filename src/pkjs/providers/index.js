'use strict';

// Provider registry. Each station carries a `provider` tag; fetches route to the
// matching adapter ({ hiloUrl, parseHilo }). This is the seam NOAA plugs into
// later (issue #31).

var REGISTRY = {
  dfo: require('./dfo'),
  noaa: require('./noaa'),
};

function forStation(station) {
  var name = station && station.provider;
  var adapter = name && REGISTRY[name];
  if (!adapter) {
    throw new Error('Unknown provider "' + name + '" for station ' +
      (station && station.id));
  }
  return adapter;
}

// Turn a raw hilo response into blob-ready points, routing by the station's
// provider. Response shape is the adapter's concern -- DFO returns a bare
// array, NOAA a { predictions:[...] } object -- so callers must NOT pre-validate
// the payload (that DFO-only Array.isArray guard left NOAA stuck on "Loading").
// Returns [] on transport error or unusable payload so the caller keeps cache.
function pointsFor(station, err, raw) {
  if (err || raw == null) {
    return [];
  }
  return forStation(station).parseHilo(raw);
}

module.exports = { forStation: forStation, pointsFor: pointsFor, REGISTRY: REGISTRY };
