'use strict';

// NOAA CO-OPS provider adapter (issue #32). Same interface as dfo.js
// ({ hiloUrl, parseHilo }) so index.js stays provider-agnostic. NOAA returns
// pre-classified hilo predictions, so no classifyExtrema step here.

var NOAA_HOST = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';

function ymd(date) {
  var y = date.getUTCFullYear();
  var m = date.getUTCMonth() + 1;
  var d = date.getUTCDate();
  return '' + y + (m < 10 ? '0' + m : m) + (d < 10 ? '0' + d : d);
}

function hiloUrl(station, from, to) {
  return NOAA_HOST +
    '?product=predictions' +
    '&interval=hilo' +
    '&datum=MLLW' +
    '&units=metric' +
    '&time_zone=gmt' +
    '&format=json' +
    '&application=pebble_tides' +
    '&station=' + station.id +
    '&begin_date=' + ymd(from) +
    '&end_date=' + ymd(to);
}

function parseHilo(json) {
  if (!json || !Array.isArray(json.predictions)) {
    return [];
  }
  return json.predictions.map(function (p) {
    return {
      epoch: Math.floor(Date.parse(p.t.replace(' ', 'T') + ':00Z') / 1000),
      heightCm: Math.round(parseFloat(p.v) * 100),
      kind: p.type === 'H' ? 1 : 2,
    };
  });
}

// NOAA MDAPI station catalog. Used to load the NOAA station list dynamically
// instead of hand-seeding it (issue #33). `type=tidepredictions` returns both
// reference (R) and subordinate (S) stations; we keep both since both yield
// hilo predictions via the datagetter above.
var MDAPI_CATALOG_URL =
  'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions';

function catalogUrl() {
  return MDAPI_CATALOG_URL;
}

// Trim the MDAPI response to the fields selection needs. `id` is numeric in the
// JSON; coerce to string so it matches the seed/fetch key type. Keep R and S.
function parseCatalog(json) {
  if (!json || !Array.isArray(json.stations)) {
    return [];
  }
  return json.stations.map(function (s) {
    return {
      id: String(s.id),
      name: s.name,
      lat: s.lat,
      lng: s.lng,
      provider: 'noaa',
    };
  });
}

module.exports = {
  hiloUrl: hiloUrl,
  parseHilo: parseHilo,
  NOAA_HOST: NOAA_HOST,
  catalogUrl: catalogUrl,
  parseCatalog: parseCatalog,
};
