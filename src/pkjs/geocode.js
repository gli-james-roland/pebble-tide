'use strict';

// Geocode a place name to coordinates via OSM Nominatim (ADR 0004). No API key;
// Nominatim's usage policy requires an identifying User-Agent and is fine for
// the occasional, user-initiated lookup this app does. geocodeUrl/parseGeocode
// are pure and unit-tested; geocode() is the XHR glue.

var NOMINATIM = 'https://nominatim.openstreetmap.org/search';
var USER_AGENT = 'pebble_tides (https://github.com/gli-james-roland/pebble-tide)';

function geocodeUrl(place) {
  return NOMINATIM + '?format=json&limit=1&q=' + encodeURIComponent(place);
}

function parseGeocode(json) {
  if (!Array.isArray(json) || json.length === 0) {
    return null;
  }
  var top = json[0];
  var lat = parseFloat(top.lat);
  var lon = parseFloat(top.lon);
  if (isNaN(lat) || isNaN(lon)) {
    return null;
  }
  return { lat: lat, lon: lon };
}

// geocode(place, cb): cb({lat, lon}) on success, cb(null) on any failure.
function geocode(place, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', geocodeUrl(place), true);
  xhr.timeout = 15000;
  try { xhr.setRequestHeader('User-Agent', USER_AGENT); } catch (e) { /* forbidden header must not abort */ }
  xhr.onload = function () {
    if (xhr.status < 200 || xhr.status >= 300) { cb(null); return; }
    try { cb(parseGeocode(JSON.parse(xhr.responseText))); }
    catch (e) { cb(null); }
  };
  xhr.onerror = function () { cb(null); };
  xhr.ontimeout = function () { cb(null); };
  xhr.send();
}

module.exports = { geocodeUrl: geocodeUrl, parseGeocode: parseGeocode, geocode: geocode, NOMINATIM: NOMINATIM };
