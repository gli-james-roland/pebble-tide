'use strict';

// Per-Provider station catalog cache (issue #33). NOAA stations load
// dynamically rather than from the hand-seeded list; DFO reuses this in #34.
//
// localStorage schema, under key `stationCatalog`:
//   { dfo:  { stations: [...], fetchedAt: <ms epoch> },
//     noaa: { stations: [...], fetchedAt: <ms epoch> } }
// Each slice holds trimmed catalog records: { id, name, lat, lng, provider }.
//
// Storage is injected (a localStorage-like { getItem, setItem }) so tests can
// pass a fake; index.js passes the real localStorage.

var CACHE_KEY = 'stationCatalog';

function readCache(storage) {
  try {
    var raw = storage.getItem(CACHE_KEY);
    if (!raw) {
      return {};
    }
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

// Merge one provider's slice into the cache, preserving every other slice,
// then persist. fetchedAt is the ms-epoch timestamp of the fetch. version is
// the catalog format version at write time (see orchestrate.CATALOG_VERSION);
// a version bump triggers a background refresh (issue #35). Reads stay
// backward-safe: a slice with no version is treated as needing refresh.
function writeSlice(storage, provider, stations, fetchedAt, version) {
  var cache = readCache(storage);
  cache[provider] = { stations: stations, fetchedAt: fetchedAt, version: version };
  try {
    storage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch (e) { /* localStorage may be unavailable; non-fatal */ }
  return cache;
}

// Trimmed catalog records use name + lat/lng; seed stations use officialName +
// latitude/longitude. Normalize both to the SEED shape (the canonical one
// `geo.nearestUsableStation` and downstream index.js/blob code expect):
//   { id, officialName, operating, latitude, longitude, provider }
// Catalog entries are usable by construction, so operating is forced true.
function normalizeCatalogRecord(rec) {
  return {
    id: rec.id,
    officialName: rec.name,
    operating: true,
    latitude: rec.lat,
    longitude: rec.lng,
    provider: rec.provider,
  };
}

// One candidate list = every present cache slice (normalized), PLUS seed
// stations for any provider with NO cache slice. A provider with a live slice
// does not also pull its seed entries, so no duplicates.
function unionStations(cache, seed) {
  var out = [];
  var coveredProviders = {};
  Object.keys(cache).forEach(function (provider) {
    coveredProviders[provider] = true;
    var slice = cache[provider];
    var stations = (slice && slice.stations) || [];
    stations.forEach(function (rec) {
      out.push(normalizeCatalogRecord(rec));
    });
  });
  seed.forEach(function (s) {
    if (!coveredProviders[s.provider]) {
      out.push(s);
    }
  });
  return out;
}

module.exports = {
  CACHE_KEY: CACHE_KEY,
  readCache: readCache,
  writeSlice: writeSlice,
  unionStations: unionStations,
};
