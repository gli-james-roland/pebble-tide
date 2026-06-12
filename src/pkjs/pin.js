'use strict';

// Pinned Station state (ADR 0004), kept separate from display config (config.js).
// Persisted on the phone so it survives launches and drives the skip-geolocation
// behaviour in Pinned Mode. Storage is injected for testability; index.js passes
// the real localStorage.
//
// record: { mode:'auto'|'pinned', place, station|null, rangeDays, distanceKm, error|null }

var STORE_KEY = 'tidePin';
var RANGES = [7, 15, 30, 45];
var DEFAULT_RANGE = 15;

function read(storage) {
  try {
    var raw = storage.getItem(STORE_KEY);
    if (!raw) { return { mode: 'auto' }; }
    var p = JSON.parse(raw);
    return (p && p.mode === 'pinned') ? p : { mode: 'auto' };
  } catch (e) {
    return { mode: 'auto' };
  }
}

function write(storage, rec) {
  try { storage.setItem(STORE_KEY, JSON.stringify(rec)); } catch (e) { /* non-fatal */ }
  return rec;
}

function clear(storage) {
  try { storage.removeItem(STORE_KEY); } catch (e) { /* non-fatal */ }
  return { mode: 'auto' };
}

// Snap a range to one of the allowed values, else the default.
function normalizeRange(n) {
  return RANGES.indexOf(n) !== -1 ? n : DEFAULT_RANGE;
}

// Pull the location fields out of the config webview's JSON response. Returns
// { mode, place, rangeDays }, or null if the response can't be parsed.
function parseResponse(response) {
  try {
    var decoded = response.match(/^\{/) ? response : decodeURIComponent(response);
    var p = JSON.parse(decoded);
    return {
      mode: p.locationMode === 'pinned' ? 'pinned' : 'auto',
      place: typeof p.place === 'string' ? p.place.trim() : '',
      rangeDays: normalizeRange(p.range),
    };
  } catch (e) {
    return null;
  }
}

module.exports = {
  STORE_KEY: STORE_KEY, RANGES: RANGES, DEFAULT_RANGE: DEFAULT_RANGE,
  read: read, write: write, clear: clear,
  normalizeRange: normalizeRange, parseResponse: parseResponse,
};
