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
  return tides.classifyExtrema(json).map(function (x) {
    return { epoch: x.epoch, heightCm: x.heightCm, kind: x.type === 'HIGH' ? 1 : 2 };
  });
}

module.exports = { hiloUrl: hiloUrl, parseHilo: parseHilo, IWLS_HOST: IWLS_HOST };
