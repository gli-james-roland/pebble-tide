'use strict';

// Binary cache format shared phone -> watch. Little-endian to match the ARM
// watch, which memcpy's the fields directly. See docs/adr/0001 and CONTEXT.md.
//
// Layout (v3):
//   u8  version
//   u8  flags        (bit0: nearest station is far, >500 km)
//   u16 distanceKm
//   u8  nameLen
//   u8  name[nameLen]   (ASCII)
//   u16 pointCount
//   pointCount x { i32 epoch; i16 heightCm; u8 kind(0=plain,1=HIGH,2=LOW) }
//   u8  sunDayCount
//   sunDayCount x { i32 sunriseEpoch; i32 sunsetEpoch }   (unix secs, UTC)
//
// Points are the merged curve + extrema polyline (see docs/adr/0001): plain
// hourly samples carry the shape; kind 1/2 points are the exact turning points.
// The sun section (issue #8) carries per-UTC-day sunrise/sunset so the watch
// shades night hours behind the curve, fully offline.

var BLOB_VERSION = 3;
var RECORD_BYTES = 7;
var SUN_RECORD_BYTES = 8;
var FAR_KM = 500;

function packWeek(points, station, distanceKm, sunDays) {
  var name = station.officialName || '';
  var nameLen = name.length;
  var sun = sunDays || [];
  var total = 8 + nameLen + points.length * RECORD_BYTES +
    1 + sun.length * SUN_RECORD_BYTES;
  var buf = new ArrayBuffer(total);
  var dv = new DataView(buf);
  var u8 = new Uint8Array(buf);
  var o = 0;

  dv.setUint8(o, BLOB_VERSION); o += 1;
  dv.setUint8(o, distanceKm > FAR_KM ? 1 : 0); o += 1;
  dv.setUint16(o, distanceKm & 0xffff, true); o += 2;
  dv.setUint8(o, nameLen); o += 1;
  for (var i = 0; i < nameLen; i++) {
    u8[o++] = name.charCodeAt(i) & 0xff;
  }
  dv.setUint16(o, points.length, true); o += 2;
  for (var k = 0; k < points.length; k++) {
    var p = points[k];
    dv.setInt32(o, p.epoch, true); o += 4;
    dv.setInt16(o, p.heightCm, true); o += 2;
    dv.setUint8(o, p.kind); o += 1;
  }
  dv.setUint8(o, sun.length & 0xff); o += 1;
  for (var d = 0; d < sun.length; d++) {
    dv.setInt32(o, sun[d].sunriseEpoch, true); o += 4;
    dv.setInt32(o, sun[d].sunsetEpoch, true); o += 4;
  }
  return u8;
}

function unpackWeek(u8) {
  var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  var o = 0;
  var version = dv.getUint8(o); o += 1;
  var flags = dv.getUint8(o); o += 1;
  var distanceKm = dv.getUint16(o, true); o += 2;
  var nameLen = dv.getUint8(o); o += 1;
  var name = '';
  for (var i = 0; i < nameLen; i++) {
    name += String.fromCharCode(dv.getUint8(o++));
  }
  var count = dv.getUint16(o, true); o += 2;
  var points = [];
  for (var k = 0; k < count; k++) {
    var epoch = dv.getInt32(o, true); o += 4;
    var heightCm = dv.getInt16(o, true); o += 2;
    var kind = dv.getUint8(o); o += 1;
    points.push({ epoch: epoch, heightCm: heightCm, kind: kind });
  }
  var sunDays = [];
  if (o < dv.byteLength) {
    var sunCount = dv.getUint8(o); o += 1;
    for (var s = 0; s < sunCount; s++) {
      var sunriseEpoch = dv.getInt32(o, true); o += 4;
      var sunsetEpoch = dv.getInt32(o, true); o += 4;
      sunDays.push({ sunriseEpoch: sunriseEpoch, sunsetEpoch: sunsetEpoch });
    }
  }
  return {
    version: version,
    far: (flags & 1) === 1,
    distanceKm: distanceKm,
    stationName: name,
    points: points,
    sunDays: sunDays,
  };
}

function chunkBytes(u8, chunkSize) {
  var chunks = [];
  for (var off = 0; off < u8.length; off += chunkSize) {
    chunks.push(u8.subarray(off, Math.min(off + chunkSize, u8.length)));
  }
  return chunks;
}

module.exports = { packWeek, unpackWeek, chunkBytes, BLOB_VERSION };
