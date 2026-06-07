'use strict';

var tides = require('./tides');

// Issue #1 skeleton: hardcoded station, fetch the high/low series, send the
// next upcoming tide to the watch. Location, caching, and the full week land
// in later slices.
var IWLS_HOST = 'https://api-iwls.dfo-mpo.gc.ca';
var STATION_ID = '5cebf1e43d0f4a073c4bc45a'; // Ambleside (temporary, until #2)
var STATION_NAME = 'Ambleside';

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

function sendNextTide(extrema) {
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
    STATION_NAME: STATION_NAME,
  }, function () {
    console.log('Sent next tide: ' + next.type + ' @ ' + next.epoch);
  }, function (e) {
    console.log('Failed to send next tide: ' + JSON.stringify(e));
  });
}

function fetchAndSend() {
  var now = new Date();
  var to = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000); // 2 days is plenty for "next"
  var url = hiloUrl(STATION_ID, now, to);
  var xhr = new XMLHttpRequest();
  xhr.open('GET', url, true);
  xhr.timeout = 15000;
  xhr.onload = function () {
    if (xhr.status < 200 || xhr.status >= 300) {
      console.log('IWLS returned status ' + xhr.status);
      return;
    }
    try {
      var data = JSON.parse(xhr.responseText);
      if (!Array.isArray(data) || data.length === 0) {
        console.log('IWLS returned no extrema');
        return;
      }
      sendNextTide(data);
    } catch (err) {
      console.log('Failed to parse IWLS response: ' + err);
    }
  };
  xhr.onerror = function () { console.log('IWLS request errored'); };
  xhr.ontimeout = function () { console.log('IWLS request timed out'); };
  xhr.send();
}

Pebble.addEventListener('ready', function () {
  console.log('pebble_tides pkjs ready');
  fetchAndSend();
});
