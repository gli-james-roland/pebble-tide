'use strict';

// Per-station tide-blob cache on the phone (region offline feature, ADR 0006).
// Each station's packed blob (blob.packWeek output) is stored under its own key
// so a station can be written, read, or evicted independently and an interrupted
// region download leaves completed stations intact.
//
// localStorage value per key `tideBlob:<stationId>`:
//   { date: "YYYY-MM-DD", version: <BLOB_VERSION>, b64: "<base64 of the bytes>" }
//
// Bytes are base64-encoded, not stored as a JSON number array: base64 is ~1.33x
// the raw size, a number array is ~3-4x, and the region storage budget (ADR 0007)
// is sized for base64. Storage is injected so tests pass a fake localStorage.

var KEY_PREFIX = 'tideBlob:';
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function keyFor(id) {
  return KEY_PREFIX + id;
}

// Encode a Uint8Array to a base64 string. Self-contained (no btoa/Buffer) so it
// runs the same in pypkjs, the device, and node tests.
function encode(u8) {
  var out = '';
  var i;
  for (i = 0; i + 2 < u8.length; i += 3) {
    var n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  var rem = u8.length - i;
  if (rem === 1) {
    var a = u8[i] << 16;
    out += B64[(a >> 18) & 63] + B64[(a >> 12) & 63] + '==';
  } else if (rem === 2) {
    var b = (u8[i] << 16) | (u8[i + 1] << 8);
    out += B64[(b >> 18) & 63] + B64[(b >> 12) & 63] + B64[(b >> 6) & 63] + '=';
  }
  return out;
}

// Decode a base64 string back to a Uint8Array.
function decode(str) {
  var clean = str.replace(/=+$/, '');
  var len = (clean.length * 3) >> 2;
  var u8 = new Uint8Array(len);
  var o = 0;
  var buf = 0;
  var bits = 0;
  for (var i = 0; i < clean.length; i++) {
    var v = B64.indexOf(clean[i]);
    if (v < 0) { continue; }
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      u8[o++] = (buf >> bits) & 0xff;
    }
  }
  return u8;
}

function setBytes(storage, id, u8, date, version) {
  var rec = { date: date, version: version, b64: encode(u8) };
  try { storage.setItem(keyFor(id), JSON.stringify(rec)); return true; }
  catch (e) { return false; } // quota or unavailable; caller decides what to do
}

function getBytes(storage, id) {
  try {
    var raw = storage.getItem(keyFor(id));
    if (!raw) { return null; }
    var rec = JSON.parse(raw);
    return { u8: decode(rec.b64), date: rec.date, version: rec.version };
  } catch (e) {
    return null;
  }
}

function clear(storage, id) {
  try { storage.removeItem(keyFor(id)); } catch (e) { /* non-fatal */ }
}

// Drop blobs orphaned by a region change. `oldIds` is the previous region's
// authoritative station id list (region record's stations[]); `keepIds` is the
// new set. Every old id not in keepIds is removed. We diff explicit id lists
// rather than iterating localStorage keys: under pypkjs key iteration is O(n)
// and unstably ordered (ADR 0006). Returns the number of blobs removed.
function evict(storage, oldIds, keepIds) {
  var old = oldIds || [];
  var keep = {};
  (keepIds || []).forEach(function (id) { keep[id] = true; });
  var removed = 0;
  old.forEach(function (id) {
    if (!keep[id]) { clear(storage, id); removed++; }
  });
  return removed;
}

module.exports = {
  KEY_PREFIX: KEY_PREFIX,
  keyFor: keyFor,
  encode: encode,
  decode: decode,
  setBytes: setBytes,
  getBytes: getBytes,
  clear: clear,
  evict: evict,
};
