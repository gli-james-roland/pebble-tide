'use strict';

// Pure tide-parsing helpers shared between the Pebble JS bundle and Node tests.
// CommonJS so it loads under both enableMultiJS and node:test.

function eventToPoint(e) {
  return {
    epoch: Math.floor(Date.parse(e.eventDate) / 1000),
    heightCm: Math.round(e.value * 100),
  };
}

function classifyExtrema(extrema) {
  return extrema.map(function (e, i) {
    // A hilo series strictly alternates, so a point higher than its neighbor
    // is a HIGH. The first point has no predecessor, so look forward instead.
    var neighbor = i > 0 ? extrema[i - 1].value : extrema[i + 1].value;
    var p = eventToPoint(e);
    p.type = e.value > neighbor ? 'HIGH' : 'LOW';
    return p;
  });
}

function pickNextExtremum(classified, nowEpoch) {
  for (var i = 0; i < classified.length; i++) {
    if (classified[i].epoch >= nowEpoch) {
      return classified[i];
    }
  }
  return null;
}

module.exports = { classifyExtrema, pickNextExtremum };
