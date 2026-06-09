'use strict';

// DFO IWLS provider adapter. Owns the DFO-specific URL shape and hilo parsing
// so index.js stays provider-agnostic (issue #31). The watch draws a cosine
// curve between extrema (ADR 0002), so we only fetch the high/low series.

var tides = require('../tides');

var IWLS_HOST = 'https://api-iwls.dfo-mpo.gc.ca';

function isoZ(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function hiloUrl(station, from, to) {
  return IWLS_HOST + '/api/v1/stations/' + station.id +
    '/data?time-series-code=wlp-hilo' +
    '&from=' + isoZ(from) +
    '&to=' + isoZ(to) +
    '&resolution=ALL';
}

function parseHilo(json) {
  if (!Array.isArray(json)) {
    return [];
  }
  return tides.classifyExtrema(json).map(function (x) {
    return { epoch: x.epoch, heightCm: x.heightCm, kind: x.type === 'HIGH' ? 1 : 2 };
  });
}

// DFO IWLS station catalog (issue #34). Loads the full Canadian station list
// dynamically instead of the hand-seeded BC subset. Mirrors noaa.js's
// catalogUrl()/parseCatalog() so index.js stays provider-agnostic.
function catalogUrl() {
  return IWLS_HOST + '/api/v1/stations';
}

// GET /api/v1/stations returns an ARRAY of stations. A Usable DFO station is
// operating AND advertises the `wlp-hilo` product in its timeSeries (the hilo
// fetch above needs that series). Stations without it are excluded. Trim each
// kept record to the cache-slice shape { id, name, lat, lng, provider } so
// catalog.unionStations normalizes it the same way as NOAA. `id` keeps the full
// DFO identifier (it is the hilo fetch key).
function parseCatalog(json) {
  if (!Array.isArray(json)) {
    return [];
  }
  return json.filter(function (s) {
    return s && s.operating === true && Array.isArray(s.timeSeries) &&
      s.timeSeries.some(function (ts) { return ts && ts.code === 'wlp-hilo'; });
  }).map(function (s) {
    return {
      id: s.id,
      name: s.officialName,
      lat: s.latitude,
      lng: s.longitude,
      provider: 'dfo',
    };
  });
}

module.exports = {
  hiloUrl: hiloUrl,
  parseHilo: parseHilo,
  IWLS_HOST: IWLS_HOST,
  catalogUrl: catalogUrl,
  parseCatalog: parseCatalog,
};
