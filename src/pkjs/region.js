'use strict';

// Pinned-region state (ADR 0006), replacing the single-station pin (pin.js,
// ADR 0004) on the offline path. A region is a geocoded center + radius + a
// capped set of nearby stations whose blobs are cached on the phone
// (blobcache.js). Persisted so it survives launches and drives the
// region-serve flow in index.js. Storage is injected for testability.
//
// record: {
//   mode: 'region', place, center: { lat, lon }, radiusKm, cap,
//   stations: [ { id, officialName, latitude, longitude, provider, tz, region } ],
//   fetchedAt: 'YYYY-MM-DD', rangeDays, truncated: bool, error: string|null
// }

var STORE_KEY = 'tideRegion';
var RADII = [25, 75, 150, 300];      // km presets offered in config
var DEFAULT_RADIUS = 75;
var RANGES = [7, 15, 30, 45];
var DEFAULT_RANGE = 45;              // regions default to the full offline window

function read(storage) {
  try {
    var raw = storage.getItem(STORE_KEY);
    if (!raw) { return { mode: 'auto' }; }
    var r = JSON.parse(raw);
    return (r && r.mode === 'region') ? r : { mode: 'auto' };
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

function normalizeRadius(n) {
  return RADII.indexOf(n) !== -1 ? n : DEFAULT_RADIUS;
}

function normalizeRange(n) {
  return RANGES.indexOf(n) !== -1 ? n : DEFAULT_RANGE;
}

// Pull the location fields out of the config webview's JSON response. Returns
// { mode, place, radiusKm, rangeDays }, or null if it can't be parsed.
function parseResponse(response) {
  try {
    var decoded = response.match(/^\{/) ? response : decodeURIComponent(response);
    var p = JSON.parse(decoded);
    return {
      mode: p.locationMode === 'region' ? 'region' : 'auto',
      place: typeof p.place === 'string' ? p.place.trim() : '',
      radiusKm: normalizeRadius(p.radius),
      rangeDays: normalizeRange(p.range),
    };
  } catch (e) {
    return null;
  }
}

module.exports = {
  STORE_KEY: STORE_KEY,
  RADII: RADII, DEFAULT_RADIUS: DEFAULT_RADIUS,
  RANGES: RANGES, DEFAULT_RANGE: DEFAULT_RANGE,
  read: read, write: write, clear: clear,
  normalizeRadius: normalizeRadius, normalizeRange: normalizeRange,
  parseResponse: parseResponse,
};
