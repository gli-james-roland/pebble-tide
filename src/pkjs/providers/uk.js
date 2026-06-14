'use strict';

// UK (British Isles) provider adapter. Draws from UKHO's keyless EasyTide
// consumer endpoints (ADR 0008). Same interface as the other adapters
// ({ catalogUrl, parseCatalog, hiloUrl, parseHilo }) so index.js stays
// provider-agnostic. Endpoints need no request headers and return JSON, so
// no responseFormat/requestHeaders here.

var CATALOG_URL = 'https://easytide.admiralty.co.uk/Home/GetStations';
var PRED_HOST = 'https://easytide.admiralty.co.uk/Home/GetPredictionData';

// GetStations returns the global Admiralty set; this whitelist scopes the
// Provider to the British Isles and keeps it from overlapping BOM/NOAA. Exact
// Country strings confirmed against the live response (spike #78). There is no
// "United Kingdom" value.
var BRITISH_ISLES = {
  England: true,
  Scotland: true,
  Wales: true,
  'Northern Ireland': true,
  Ireland: true,
  'Channel Islands': true,
  'Isle of Man': true,
};

function catalogUrl() {
  return CATALOG_URL;
}

// GetStations is a GeoJSON FeatureCollection. Keep only British-Isles Country
// values, then trim to the catalog-slice shape. coordinates are [lon, lat], so
// lat is index 1, lng is index 0.
function parseCatalog(json) {
  if (!json || !Array.isArray(json.features)) {
    return [];
  }
  var out = [];
  json.features.forEach(function (f) {
    var p = f && f.properties;
    var g = f && f.geometry;
    if (!p || !g || !BRITISH_ISLES[p.Country]) {
      return;
    }
    var c = g.coordinates;
    out.push({
      id: p.Id,
      name: p.Name,
      lat: c[1],
      lng: c[0],
      provider: 'uk',
    });
  });
  return out;
}

// GetPredictionData returns a fixed ~8-day window and ignores any date range,
// so from/to are unused.
function hiloUrl(station, from, to) {
  return PRED_HOST + '?stationId=' + encodeURIComponent(station.id);
}

// GetPredictionData returns JSON { tidalEventList: [{eventType, dateTime,
// height}] }. dateTime has no offset and is UTC, so append 'Z' before parsing
// (like NOAA/DFO). height is metres above Chart Datum. eventType 0=High, 1=Low.
function parseHilo(json) {
  if (!json || !Array.isArray(json.tidalEventList)) {
    return [];
  }
  return json.tidalEventList.map(function (e) {
    return {
      epoch: Math.floor(Date.parse(e.dateTime + 'Z') / 1000),
      heightCm: Math.round(e.height * 100),
      kind: e.eventType === 0 ? 1 : 2,
    };
  });
}

module.exports = {
  catalogUrl: catalogUrl,
  parseCatalog: parseCatalog,
  hiloUrl: hiloUrl,
  parseHilo: parseHilo,
  CATALOG_URL: CATALOG_URL,
  PRED_HOST: PRED_HOST,
};
