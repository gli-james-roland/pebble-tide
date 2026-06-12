'use strict';

// BOM (Bureau of Meteorology) provider adapter. Covers Australia, the South
// Pacific, and Antarctica. Unlike NOAA/DFO, BOM serves no JSON prediction API:
// the catalog is a GeoJSON file and predictions come as an HTML table parsed in
// parseHilo (Task 3). BOM blocks non-browser clients, so the fetch layer sends a
// browser User-Agent (responseFormat/requestHeaders below, wired in index.js).

var CATALOG_URL =
  'https://www.bom.gov.au/australia/tides/tide_prediction_sites.json';

function catalogUrl() {
  return CATALOG_URL;
}

// tide_prediction_sites.json is a GeoJSON FeatureCollection. Each feature's
// properties carry AAC (the prediction key), PORT_NAME, LAT/LON, STATE_CODE
// (the region= URL param), TIME_ZONE (the tz= URL param), and AVAIL_FLAG.
// Keep AVAIL_FLAG === 'Y'. tz/region ride along in the record because hiloUrl
// needs them; catalog.normalizeCatalogRecord preserves them through the cache.
function parseCatalog(json) {
  if (!json || !Array.isArray(json.features)) {
    return [];
  }
  var out = [];
  json.features.forEach(function (f) {
    var p = f && f.properties;
    if (!p || p.AVAIL_FLAG !== 'Y') {
      return;
    }
    out.push({
      id: p.AAC,
      name: p.PORT_NAME,
      lat: p.LAT,
      lng: p.LON,
      provider: 'bom',
      tz: p.TIME_ZONE,
      region: p.STATE_CODE,
    });
  });
  return out;
}

var TABLE_HOST =
  'https://www.bom.gov.au/australia/tides/scripts/getTidesTable.php';
var DAY_MS = 24 * 60 * 60 * 1000;

// BOM's date param is DD-MM-YYYY. Use UTC components so the URL is deterministic
// in tests; the app over-fetches (1 day back + 7 forward) so a one-day tz slack
// is harmless.
function dmy(date) {
  var d = ('0' + date.getUTCDate()).slice(-2);
  var m = ('0' + (date.getUTCMonth() + 1)).slice(-2);
  return d + '-' + m + '-' + date.getUTCFullYear();
}

// getTidesTable returns one day-table per day starting at `date`, for `days`
// days. region and tz come off the station record (BOM-only fields from
// parseCatalog). tz_js is a display label BOM ignores for the data, left empty.
function hiloUrl(station, from, to) {
  var days = Math.ceil((to.getTime() - from.getTime()) / DAY_MS);
  return TABLE_HOST +
    '?type=tide' +
    '&aac=' + encodeURIComponent(station.id) +
    '&date=' + dmy(from) +
    '&days=' + days +
    '&region=' + encodeURIComponent(station.region) +
    '&offset=0&offsetName=' +
    '&tz=' + encodeURIComponent(station.tz) +
    '&tz_js=';
}

module.exports = {
  catalogUrl: catalogUrl,
  parseCatalog: parseCatalog,
  hiloUrl: hiloUrl,
  CATALOG_URL: CATALOG_URL,
  TABLE_HOST: TABLE_HOST,
};
