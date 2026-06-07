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

// Raw 60-minute wlp samples -> plain curve points.
function toCurvePoints(raw) {
  return raw.map(eventToPoint);
}

// Merge the curve and the exact extrema into one time-ordered polyline so the
// drawn line passes through the true turning points (see docs/adr/0001).
// kind: 0 = plain curve sample, 1 = HIGH, 2 = LOW.
function mergePoints(curve, extrema) {
  var pts = [];
  curve.forEach(function (p) {
    pts.push({ epoch: p.epoch, heightCm: p.heightCm, kind: 0 });
  });
  extrema.forEach(function (e) {
    pts.push({ epoch: e.epoch, heightCm: e.heightCm, kind: e.type === 'HIGH' ? 1 : 2 });
  });
  pts.sort(function (a, b) { return a.epoch - b.epoch; });
  return pts;
}

function pickNextExtremum(classified, nowEpoch) {
  for (var i = 0; i < classified.length; i++) {
    if (classified[i].epoch >= nowEpoch) {
      return classified[i];
    }
  }
  return null;
}

module.exports = { classifyExtrema, pickNextExtremum, toCurvePoints, mergePoints };
