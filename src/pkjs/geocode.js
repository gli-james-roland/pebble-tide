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

// geocode(place, cb): cb(coords, reason). On success coords is {lat, lon} and
// reason is null. On failure coords is null and reason says WHY (#63 case 2):
//   'offline'  -- transport failure (network error, timeout, non-2xx status):
//                 the lookup never reached a usable answer, so the caller tells
//                 the user to connect to the internet.
//   'notfound' -- the server answered but the place has no match (empty result)
//                 or returned an unusable body.
// The distinction matters: an offline pin must not read as "Couldn't find".
function geocode(place, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', geocodeUrl(place), true);
  xhr.timeout = 15000;
  try { xhr.setRequestHeader('User-Agent', USER_AGENT); } catch (e) { /* forbidden header must not abort */ }
  xhr.onload = function () {
    if (xhr.status < 200 || xhr.status >= 300) { cb(null, 'offline'); return; }
    var coords;
    try { coords = parseGeocode(JSON.parse(xhr.responseText)); }
    catch (e) { cb(null, 'notfound'); return; } // reachable server, bad body
    cb(coords, coords ? null : 'notfound');
  };
  xhr.onerror = function () { cb(null, 'offline'); };
  xhr.ontimeout = function () { cb(null, 'offline'); };
  xhr.send();
}

module.exports = { geocodeUrl: geocodeUrl, parseGeocode: parseGeocode, geocode: geocode, NOMINATIM: NOMINATIM };
