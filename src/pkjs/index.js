'use strict';

var tides = require('./tides');
var geo = require('./geo');
var blob = require('./blob');
var refresh = require('./refresh');
var STATIONS = require('./stations');

// Issue #3: fetch a full week of high/low extrema, pack into a versioned blob,
// and stream it to the watch in chunks. Refresh only on a new calendar day or
// a changed nearest station. The watch persists the blob and works offline.
var IWLS_HOST = 'https://api-iwls.dfo-mpo.gc.ca';
var WEEK_DAYS = 7;
var CHUNK_SIZE = 64; // bytes per AppMessage; must match CHUNK_SIZE on the watch
var META_KEY = 'cacheMeta';
var LAST_STATION_KEY = 'lastStation';

function isoZ(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function todayStr() {
  var d = new Date();
  var m = ('0' + (d.getMonth() + 1)).slice(-2);
  var day = ('0' + d.getDate()).slice(-2);
  return d.getFullYear() + '-' + m + '-' + day;
}

function hiloUrl(stationId, fromDate, toDate) {
  return IWLS_HOST + '/api/v1/stations/' + stationId +
    '/data?time-series-code=wlp-hilo' +
    '&from=' + isoZ(fromDate) +
    '&to=' + isoZ(toDate) +
    '&resolution=ALL';
}

function readJson(key) {
  try {
    var raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) { /* localStorage may be unavailable; non-fatal */ }
}

function sendBlob(u8, stationId, onDone) {
  var chunks = blob.chunkBytes(u8, CHUNK_SIZE);
  var total = chunks.length;
  function sendChunk(i) {
    if (i >= total) {
      console.log('Blob sent: ' + total + ' chunks, ' + u8.length + ' bytes');
      if (onDone) { onDone(); }
      return;
    }
    Pebble.sendAppMessage({
      CHUNK_INDEX: i,
      CHUNK_TOTAL: total,
      CHUNK_DATA: Array.prototype.slice.call(chunks[i]),
    }, function () {
      sendChunk(i + 1); // ACK received -> send the next chunk
    }, function (e) {
      console.log('Chunk ' + i + ' failed: ' + JSON.stringify(e));
    });
  }
  sendChunk(0);
}

function fetchWeek(station, distanceKm) {
  var now = new Date();
  var to = new Date(now.getTime() + WEEK_DAYS * 24 * 60 * 60 * 1000);
  var xhr = new XMLHttpRequest();
  xhr.open('GET', hiloUrl(station.id, now, to), true);
  xhr.timeout = 20000;
  xhr.onload = function () {
    if (xhr.status < 200 || xhr.status >= 300) {
      console.log('IWLS status ' + xhr.status + '; keeping existing cache');
      return;
    }
    try {
      var data = JSON.parse(xhr.responseText);
      if (!Array.isArray(data) || data.length === 0) {
        console.log('IWLS returned no extrema; keeping existing cache');
        return;
      }
      var classified = tides.classifyExtrema(data);
      var u8 = blob.packWeek(classified, station, distanceKm);
      sendBlob(u8, station.id, function () {
        writeJson(META_KEY, { date: todayStr(), stationId: station.id });
      });
    } catch (err) {
      console.log('Failed to handle IWLS response: ' + err);
    }
  };
  xhr.onerror = function () { console.log('IWLS errored; keeping existing cache'); };
  xhr.ontimeout = function () { console.log('IWLS timed out; keeping existing cache'); };
  xhr.send();
}

function maybeRefresh(station, distanceKm) {
  if (refresh.shouldRefresh(todayStr(), station.id, readJson(META_KEY))) {
    console.log('Refreshing week for ' + station.officialName);
    fetchWeek(station, distanceKm);
  } else {
    console.log('Cache is fresh for ' + station.officialName + '; not fetching');
  }
}

function onPosition(pos) {
  var result = geo.nearestUsableStation(STATIONS, pos.coords.latitude, pos.coords.longitude);
  if (!result) {
    console.log('No usable station found');
    return;
  }
  writeJson(LAST_STATION_KEY, {
    id: result.station.id, officialName: result.station.officialName,
    latitude: result.station.latitude, longitude: result.station.longitude,
    operating: result.station.operating, distanceKm: result.distanceKm,
  });
  maybeRefresh(result.station, result.distanceKm);
}

function onPositionError(err) {
  console.log('Geolocation failed (' + err.code + '): ' + err.message);
  var last = readJson(LAST_STATION_KEY);
  if (last) {
    console.log('Falling back to last station: ' + last.officialName);
    maybeRefresh(last, last.distanceKm || 0);
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
