'use strict';

// Pure decision logic for catalog loading over the launch lifecycle (issue #35).
// No globals, no I/O — index.js is the thin glue that calls these and performs
// the fetches/writes. Mirrors refresh.js: testable rules live here.
//
// Lifecycle (enforced by index.js using these functions):
//   - First run, no cache, online: await catalog fetch(es), then select.
//   - Cache present: select instantly from the union; never block on a fetch.
//   - Background refresh: per provider, refresh a slice when it is older than
//     CATALOG_TTL_MS OR its stored version != the current catalog version.
//   - Per-provider failure isolation: a failed fetch keeps the last-good slice.

// 30 days in ms. A catalog older than this gets a background refresh.
var CATALOG_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// The catalog format version. Tracks blob.BLOB_VERSION so an app update that
// bumps the blob format also forces a one-time catalog refresh on next launch.
// index.js passes blob.BLOB_VERSION in as the `currentVersion` argument; this
// constant documents the source and gives tests a stable default.
var CATALOG_VERSION = 3;

// True when at least one provider slice holds a non-empty stations array.
function hasAnyCache(cache) {
  if (!cache) {
    return false;
  }
  return Object.keys(cache).some(function (provider) {
    var slice = cache[provider];
    return !!(slice && slice.stations && slice.stations.length > 0);
  });
}

// True when a provider's slice should be refreshed in the background: it is
// absent, OR older than ttlMs, OR its stored version differs from the current
// version (missing version counts as a mismatch -> refresh).
function sliceNeedsRefresh(slice, nowMs, ttlMs, currentVersion) {
  if (!slice || typeof slice.fetchedAt !== 'number') {
    return true;
  }
  if (slice.version !== currentVersion) {
    return true;
  }
  return nowMs - slice.fetchedAt > ttlMs;
}

// The subset of providerNames whose slice needs a background refresh.
function providersToRefresh(cache, nowMs, ttlMs, currentVersion, providerNames) {
  var c = cache || {};
  return providerNames.filter(function (name) {
    return sliceNeedsRefresh(c[name], nowMs, ttlMs, currentVersion);
  });
}

// Apply a round of background refresh results to the cache, with per-provider
// failure isolation. `results` maps provider -> either
//   { ok: true, stations, fetchedAt, version }  (replace the slice), or
//   { ok: false }                                (keep the last-good slice).
// A failed fetch for an absent provider leaves it absent. Returns a new cache
// object; the input is not mutated.
function mergeRefreshResults(oldCache, results) {
  var out = {};
  var src = oldCache || {};
  Object.keys(src).forEach(function (p) { out[p] = src[p]; });
  Object.keys(results || {}).forEach(function (provider) {
    var r = results[provider];
    if (r && r.ok) {
      out[provider] = {
        stations: r.stations,
        fetchedAt: r.fetchedAt,
        version: r.version,
      };
    }
    // r.ok false -> leave out[provider] as-is (old slice retained, or absent).
  });
  return out;
}

module.exports = {
  CATALOG_TTL_MS: CATALOG_TTL_MS,
  CATALOG_VERSION: CATALOG_VERSION,
  hasAnyCache: hasAnyCache,
  sliceNeedsRefresh: sliceNeedsRefresh,
  providersToRefresh: providersToRefresh,
  mergeRefreshResults: mergeRefreshResults,
};
