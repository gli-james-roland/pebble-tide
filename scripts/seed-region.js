'use strict';
// Build a pinned-region cache offline and emit it as JSON for seed-region.py to
// write into the emulator's localStorage. This mirrors what the phone does on a
// config save (geocode -> select stations in radius -> download each blob), but
// runs under node so we can pre-seed the emulator without the config webview
// (which doesn't round-trip in the emulator; see scripts/seed-region.sh).
//
// Usage: node scripts/seed-region.js "<place>" <radiusKm> <rangeDays> <cap>
// Emits to stdout: { region: <record>, blobs: { "<id>": {date,version,b64} } }

const catalog = require('../src/pkjs/catalog');
const regionselect = require('../src/pkjs/regionselect');
const providers = require('../src/pkjs/providers');
const blob = require('../src/pkjs/blob');
const blobcache = require('../src/pkjs/blobcache');
const sun = require('../src/pkjs/sun');
const STATIONS = require('../src/pkjs/stations');

const GEO_UA = 'pebble_tides (https://github.com/gli-james-roland/pebble-tide)';
const CATALOG_PROVIDERS = ['dfo', 'noaa', 'bom'];
const BACK_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

function todayStr(d) {
  const m = ('0' + (d.getMonth() + 1)).slice(-2);
  const day = ('0' + d.getDate()).slice(-2);
  return d.getFullYear() + '-' + m + '-' + day;
}

async function getText(url, headers) {
  const res = await fetch(url, { headers: headers || {} });
  if (!res.ok) { throw new Error('HTTP ' + res.status + ' for ' + url); }
  return res.text();
}

async function geocode(place) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(place);
  const json = JSON.parse(await getText(url, { 'User-Agent': GEO_UA }));
  if (!Array.isArray(json) || !json.length) { throw new Error('geocode found nothing for "' + place + '"'); }
  return { lat: parseFloat(json[0].lat), lon: parseFloat(json[0].lon) };
}

async function fetchCatalogCache() {
  const cache = {};
  for (const name of CATALOG_PROVIDERS) {
    const adapter = providers.REGISTRY[name];
    try {
      const text = await getText(adapter.catalogUrl(), adapter.requestHeaders);
      const stations = adapter.parseCatalog(JSON.parse(text));
      cache[name] = { stations: stations, fetchedAt: Date.now(), version: blob.BLOB_VERSION };
      process.stderr.write(name + ' catalog: ' + stations.length + ' stations\n');
    } catch (e) {
      process.stderr.write(name + ' catalog failed (' + e.message + '); skipping\n');
    }
  }
  return cache;
}

function sunDaysForWindow(from, to, station) {
  const days = [];
  const dayStart = Math.floor(from.getTime() / DAY_MS) * DAY_MS;
  for (let t = dayStart; t <= to.getTime(); t += DAY_MS) {
    days.push(sun.sunTimes(t, station.latitude, station.longitude));
  }
  return days;
}

async function downloadStationBlob(station, rangeDays, now) {
  const from = new Date(now.getTime() - BACK_DAYS * DAY_MS);
  const to = new Date(now.getTime() + rangeDays * DAY_MS);
  const adapter = providers.forStation(station);
  const raw = await getText(adapter.hiloUrl(station, from, to), adapter.requestHeaders);
  // JSON providers (DFO/NOAA) hand parseHilo a parsed object; BOM gets raw text.
  const payload = adapter.responseFormat === 'text' ? raw : JSON.parse(raw);
  const points = providers.pointsFor(station, null, payload);
  if (!points.length) { return null; }
  const u8 = blob.packWeek(points, station, 0, sunDaysForWindow(from, to, station));
  return blobcache.encode(u8);
}

async function main() {
  const place = process.argv[2];
  const radiusKm = parseInt(process.argv[3] || '25', 10);
  const rangeDays = parseInt(process.argv[4] || '45', 10);
  const cap = parseInt(process.argv[5] || '400', 10);
  if (!place) { throw new Error('usage: node seed-region.js "<place>" <radiusKm> <rangeDays> <cap>'); }

  const now = new Date();
  const center = await geocode(place);
  process.stderr.write('center: ' + center.lat + ',' + center.lon + '\n');

  const candidates = catalog.unionStations(await fetchCatalogCache(), STATIONS);
  const sel = regionselect.selectRegion(candidates, center.lat, center.lon, radiusKm, cap);
  process.stderr.write('selected ' + sel.stations.length + ' stations within ' + radiusKm + ' km (truncated=' + sel.truncated + ')\n');

  const blobs = {};
  const cachedStations = [];
  for (let i = 0; i < sel.stations.length; i++) {
    const s = sel.stations[i];
    try {
      const b64 = await downloadStationBlob(s, rangeDays, now);
      if (b64) {
        blobs[s.id] = { date: todayStr(now), version: blob.BLOB_VERSION, b64: b64 };
        cachedStations.push(s);
        process.stderr.write('  [' + (i + 1) + '/' + sel.stations.length + '] cached ' + s.officialName + '\n');
      } else {
        process.stderr.write('  [' + (i + 1) + '/' + sel.stations.length + '] no points for ' + s.officialName + '; skipped\n');
      }
    } catch (e) {
      process.stderr.write('  [' + (i + 1) + '/' + sel.stations.length + '] ' + s.officialName + ' failed: ' + e.message + '\n');
    }
  }

  const region = {
    mode: 'region', place: place, center: center, radiusKm: radiusKm, cap: cap,
    stations: cachedStations, rangeDays: rangeDays, fetchedAt: todayStr(now),
    truncated: sel.truncated, error: null,
  };
  process.stdout.write(JSON.stringify({ region: region, blobs: blobs }));
  process.stderr.write('done: ' + cachedStations.length + ' stations cached\n');
}

main().catch((e) => { process.stderr.write('ERROR: ' + e.message + '\n'); process.exit(1); });
