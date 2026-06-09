'use strict';

// Provider registry. Each station carries a `provider` tag; fetches route to the
// matching adapter ({ hiloUrl, parseHilo }). This is the seam NOAA plugs into
// later (issue #31).

var REGISTRY = {
  dfo: require('./dfo'),
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

module.exports = { forStation: forStation, REGISTRY: REGISTRY };
