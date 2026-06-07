'use strict';

// Binary cache format shared phone -> watch. Little-endian to match the ARM
// watch, which memcpy's the fields directly. See docs/adr/0001 and CONTEXT.md.
//
// Layout:
//   u8  version
//   u8  flags        (bit0: nearest station is far, >500 km)
//   u16 distanceKm
//   u16 count        (number of extrema)
//   u8  nameLen
//   u8  name[nameLen]   (ASCII)
//   count x { i32 epoch; i16 heightCm; u8 type(1=HIGH,0=LOW) }

var BLOB_VERSION = 1;
var RECORD_BYTES = 7;
var FAR_KM = 500;

function packWeek(extrema, station, distanceKm) {
  var name = station.officialName || '';
  var nameLen = name.length;
  var total = 7 + nameLen + extrema.length * RECORD_BYTES;
  var buf = new ArrayBuffer(total);
  var dv = new DataView(buf);
  var u8 = new Uint8Array(buf);
  var o = 0;

  dv.setUint8(o, BLOB_VERSION); o += 1;
  dv.setUint8(o, distanceKm > FAR_KM ? 1 : 0); o += 1;
  dv.setUint16(o, distanceKm & 0xffff, true); o += 2;
  dv.setUint16(o, extrema.length, true); o += 2;
  dv.setUint8(o, nameLen); o += 1;
  for (var i = 0; i < nameLen; i++) {
    u8[o++] = name.charCodeAt(i) & 0xff;
  }
  for (var k = 0; k < extrema.length; k++) {
    var e = extrema[k];
    dv.setInt32(o, e.epoch, true); o += 4;
    dv.setInt16(o, e.heightCm, true); o += 2;
    dv.setUint8(o, e.type === 'HIGH' ? 1 : 0); o += 1;
  }
  return u8;
}

function unpackWeek(u8) {
  var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  var o = 0;
  var version = dv.getUint8(o); o += 1;
  var flags = dv.getUint8(o); o += 1;
  var distanceKm = dv.getUint16(o, true); o += 2;
  var count = dv.getUint16(o, true); o += 2;
  var nameLen = dv.getUint8(o); o += 1;
  var name = '';
  for (var i = 0; i < nameLen; i++) {
    name += String.fromCharCode(dv.getUint8(o++));
  }
  var extrema = [];
  for (var k = 0; k < count; k++) {
    var epoch = dv.getInt32(o, true); o += 4;
    var heightCm = dv.getInt16(o, true); o += 2;
    var type = dv.getUint8(o, true); o += 1;
    extrema.push({ epoch: epoch, heightCm: heightCm, type: type ? 'HIGH' : 'LOW' });
  }
  return {
    version: version,
    far: (flags & 1) === 1,
    distanceKm: distanceKm,
    stationName: name,
    extrema: extrema,
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
