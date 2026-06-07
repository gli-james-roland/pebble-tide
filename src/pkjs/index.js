'use strict';

var tides = require('./tides');
var geo = require('./geo');
var STATIONS = require('./stations');

// Issue #2: pick the nearest Usable Station from the phone's location, fetch
// its high/low series, and send the next tide to the watch. Caching and the
// full week arrive in #3.
var IWLS_HOST = 'https://api-iwls.dfo-mpo.gc.ca';
var FAR_WARNING_KM = 500;
var LAST_STATION_KEY = 'lastStation';

function isoZ(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function hiloUrl(stationId, fromDate, toDate) {
  return IWLS_HOST + '/api/v1/stations/' + stationId +
    '/data?time-series-code=wlp-hilo' +
    '&from=' + isoZ(fromDate) +
    '&to=' + isoZ(toDate) +
    '&resolution=ALL';
}

function sendNextTide(extrema, station, distanceKm) {
  var classified = tides.classifyExtrema(extrema);
  var nowEpoch = Math.floor(Date.now() / 1000);
  var next = tides.pickNextExtremum(classified, nowEpoch);
  if (!next) {
    console.log('No upcoming tide in the fetched window');
    return;
  }
  Pebble.sendAppMessage({
    NEXT_TIDE_EPOCH: next.epoch,
    NEXT_TIDE_TYPE: next.type === 'HIGH' ? 1 : 0,
    NEXT_TIDE_HEIGHT_CM: next.heightCm,
    STATION_NAME: station.officialName,
    STATION_DISTANCE_KM: Math.round(distanceKm),
  }, function () {
    console.log('Sent ' + next.type + ' for ' + station.officialName +
      ' (' + Math.round(distanceKm) + ' km)');
  }, function (e) {
    console.log('Failed to send tide: ' + JSON.stringify(e));
  });
}

function fetchForStation(station, distanceKm) {
  var now = new Date();
  var to = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  var xhr = new XMLHttpRequest();
  xhr.open('GET', hiloUrl(station.id, now, to), true);
  xhr.timeout = 15000;
  xhr.onload = function () {
    if (xhr.status < 200 || xhr.status >= 300) {
      console.log('IWLS returned status ' + xhr.status);
      return;
    }
    try {
      var data = JSON.parse(xhr.responseText);
      if (!Array.isArray(data) || data.length === 0) {
        console.log('IWLS returned no extrema for ' + station.officialName);
        return;
      }
      sendNextTide(data, station, distanceKm);
    } catch (err) {
      console.log('Failed to parse IWLS response: ' + err);
    }
  };
  xhr.onerror = function () { console.log('IWLS request errored'); };
  xhr.ontimeout = function () { console.log('IWLS request timed out'); };
  xhr.send();
}

function rememberStation(station, distanceKm) {
  try {
    localStorage.setItem(LAST_STATION_KEY, JSON.stringify({
      id: station.id, officialName: station.officialName,
      latitude: station.latitude, longitude: station.longitude,
      operating: station.operating, distanceKm: distanceKm,
    }));
  } catch (e) { /* localStorage may be unavailable; non-fatal */ }
}

function recallStation() {
  try {
    var raw = localStorage.getItem(LAST_STATION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function onPosition(pos) {
  var result = geo.nearestUsableStation(STATIONS, pos.coords.latitude, pos.coords.longitude);
  if (!result) {
    console.log('No usable station found');
    return;
  }
  if (result.distanceKm > FAR_WARNING_KM) {
    console.log('Nearest station is far: ' + Math.round(result.distanceKm) + ' km');
  }
  rememberStation(result.station, result.distanceKm);
  fetchForStation(result.station, result.distanceKm);
}

function onPositionError(err) {
  console.log('Geolocation failed (' + err.code + '): ' + err.message);
  var last = recallStation();
  if (last) {
    console.log('Falling back to last station: ' + last.officialName);
    fetchForStation(last, last.distanceKm || 0);
  } else {
    console.log('No location and no remembered station');
  }
}

Pebble.addEventListener('ready', function () {
  console.log('pebble_tides pkjs ready');
  navigator.geolocation.getCurrentPosition(onPosition, onPositionError, {
    timeout: 15000,
    maximumAge: 60000,
  });
});
