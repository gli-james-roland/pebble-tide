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

module.exports = { hiloUrl: hiloUrl, parseHilo: parseHilo, NOAA_HOST: NOAA_HOST };
