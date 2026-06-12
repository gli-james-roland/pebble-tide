# BOM (Australia) Tide Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Bureau of Meteorology (BOM) as a third tide provider so the watchapp auto-selects the nearest station and shows the day's high/low tides anywhere BOM covers (Australia, South Pacific, Antarctica).

**Architecture:** New `src/pkjs/providers/bom.js` implements the same four-function adapter interface as NOAA and DFO (`catalogUrl`, `parseCatalog`, `hiloUrl`, `parseHilo`). The catalog comes from one GeoJSON file. Predictions come from an HTML table parsed with regex. Three small shared touches: the fetch layer learns to return raw text and send a browser `User-Agent`; the catalog cache carries two extra fields (`tz`, `region`) that only BOM uses; BOM joins the catalog-provider list and seed.

**Tech Stack:** PebbleKit JS (CommonJS, ES5-style), Node.js native test runner (`node --test`). No new dependencies.

**Test command (whole suite):** `node --test test/*.test.js` — baseline is 73 pass, 2 skipped, 0 fail. Keep it there.

**Spec:** [docs/superpowers/specs/2026-06-11-bom-australia-tides-design.md](../specs/2026-06-11-bom-australia-tides-design.md)

---

## File Structure

- **Create** `src/pkjs/providers/bom.js` — the BOM adapter. One responsibility: turn BOM's catalog/table formats into the app's normalized shapes.
- **Create** `test/providers-bom.test.js` — adapter unit tests.
- **Already created (commit in Task 1):**
  - `test/fixtures/bom-sites.json` — trimmed catalog GeoJSON (Hobart + Sydney `AVAIL_FLAG:'Y'`, one synthetic `'N'` row to prove filtering).
  - `test/fixtures/bom-tides-table.html` — a real one-day `getTidesTable.php` capture (Hobart, 11 Jun 2026).
- **Modify** `src/pkjs/providers/index.js` — register `bom` in `REGISTRY`.
- **Modify** `src/pkjs/catalog.js` — `normalizeCatalogRecord` preserves optional `tz`/`region`.
- **Modify** `test/catalog.test.js` — cover the `tz`/`region` pass-through.
- **Modify** `src/pkjs/index.js` — `fetchRaw` helper, `fetchJson` accepts headers, `fetchWeek` text branch, `fetchCatalogSlice` sends headers, `onPosition` persists `tz`/`region`, `CATALOG_PROVIDERS` gains `'bom'`.
- **Modify** `src/pkjs/stations.js` — add BOM seed stations.

The normalized contracts every adapter satisfies (unchanged):
- `parseCatalog(json)` → `[{ id, name, lat, lng, provider }, ...]` (BOM also adds `tz`, `region`).
- `parseHilo(raw)` → `[{ epoch, heightCm, kind }, ...]`, `kind` 1=high 2=low, `heightCm` integer, `epoch` Unix seconds.

---

## Task 1: BOM catalog — `catalogUrl` + `parseCatalog`

**Files:**
- Create: `src/pkjs/providers/bom.js`
- Test: `test/providers-bom.test.js`
- Commit fixtures: `test/fixtures/bom-sites.json`, `test/fixtures/bom-tides-table.html`

- [ ] **Step 1: Write the failing test**

Create `test/providers-bom.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const bom = require('../src/pkjs/providers/bom');

const SITES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'bom-sites.json'), 'utf8')
);

test('catalogUrl returns the BOM tide_prediction_sites.json URL', () => {
  assert.strictEqual(
    bom.catalogUrl(),
    'https://www.bom.gov.au/australia/tides/tide_prediction_sites.json'
  );
});

test('parseCatalog maps GeoJSON features to normalized records with tz/region', () => {
  const recs = bom.parseCatalog(SITES);
  // Two AVAIL_FLAG:'Y' features kept, the 'N' one dropped.
  assert.strictEqual(recs.length, 2);
  assert.deepStrictEqual(recs[0], {
    id: 'TAS_TP003',
    name: 'Hobart',
    lat: -42.87732777777778,
    lng: 147.34095277777777,
    provider: 'bom',
    tz: 'Australia/Hobart',
    region: 'TAS',
  });
  assert.strictEqual(recs[1].id, 'NSW_TP007');
  assert.strictEqual(recs[1].region, 'NSW');
});

test('parseCatalog drops AVAIL_FLAG !== "Y"', () => {
  const recs = bom.parseCatalog(SITES);
  assert.ok(!recs.some((r) => r.id === 'NT_TP999'));
});

test('parseCatalog returns [] on null/garbage/missing features', () => {
  assert.deepStrictEqual(bom.parseCatalog(null), []);
  assert.deepStrictEqual(bom.parseCatalog({}), []);
  assert.deepStrictEqual(bom.parseCatalog({ features: 'nope' }), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/providers-bom.test.js`
Expected: FAIL — `Cannot find module '../src/pkjs/providers/bom'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/pkjs/providers/bom.js`:

```js
'use strict';

// BOM (Bureau of Meteorology) provider adapter. Covers Australia, the South
// Pacific, and Antarctica. Unlike NOAA/DFO, BOM serves no JSON prediction API:
// the catalog is a GeoJSON file and predictions come as an HTML table parsed in
// parseHilo (Task 3). BOM blocks non-browser clients, so the fetch layer sends a
// browser User-Agent (responseFormat/requestHeaders below, wired in index.js).

var CATALOG_URL =
  'https://www.bom.gov.au/australia/tides/tide_prediction_sites.json';

function catalogUrl() {
  return CATALOG_URL;
}

// tide_prediction_sites.json is a GeoJSON FeatureCollection. Each feature's
// properties carry AAC (the prediction key), PORT_NAME, LAT/LON, STATE_CODE
// (the region= URL param), TIME_ZONE (the tz= URL param), and AVAIL_FLAG.
// Keep AVAIL_FLAG === 'Y'. tz/region ride along in the record because hiloUrl
// needs them; catalog.normalizeCatalogRecord preserves them through the cache.
function parseCatalog(json) {
  if (!json || !Array.isArray(json.features)) {
    return [];
  }
  var out = [];
  json.features.forEach(function (f) {
    var p = f && f.properties;
    if (!p || p.AVAIL_FLAG !== 'Y') {
      return;
    }
    out.push({
      id: p.AAC,
      name: p.PORT_NAME,
      lat: p.LAT,
      lng: p.LON,
      provider: 'bom',
      tz: p.TIME_ZONE,
      region: p.STATE_CODE,
    });
  });
  return out;
}

module.exports = {
  catalogUrl: catalogUrl,
  parseCatalog: parseCatalog,
  CATALOG_URL: CATALOG_URL,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/providers-bom.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pkjs/providers/bom.js test/providers-bom.test.js test/fixtures/bom-sites.json test/fixtures/bom-tides-table.html
git commit -m "feat(bom): catalog adapter — catalogUrl + parseCatalog"
```

---

## Task 2: BOM `hiloUrl`

**Files:**
- Modify: `src/pkjs/providers/bom.js`
- Test: `test/providers-bom.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/providers-bom.test.js`:

```js
test('hiloUrl builds the getTidesTable URL with aac/date/days/region/tz', () => {
  const station = {
    id: 'TAS_TP003', provider: 'bom', region: 'TAS', tz: 'Australia/Hobart',
  };
  const from = new Date('2026-06-10T00:00:00Z');
  const to = new Date('2026-06-18T00:00:00Z'); // 8 days
  const url = bom.hiloUrl(station, from, to);
  assert.ok(url.indexOf('getTidesTable.php') !== -1, url);
  assert.ok(url.indexOf('type=tide') !== -1);
  assert.ok(url.indexOf('aac=TAS_TP003') !== -1);
  assert.ok(url.indexOf('date=10-06-2026') !== -1, 'DD-MM-YYYY of from: ' + url);
  assert.ok(url.indexOf('days=8') !== -1, 'whole-day span: ' + url);
  assert.ok(url.indexOf('region=TAS') !== -1);
  assert.ok(url.indexOf('tz=Australia%2FHobart') !== -1, 'tz url-encoded: ' + url);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/providers-bom.test.js`
Expected: FAIL — `bom.hiloUrl is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/pkjs/providers/bom.js`, add above `module.exports`:

```js
var TABLE_HOST =
  'https://www.bom.gov.au/australia/tides/scripts/getTidesTable.php';
var DAY_MS = 24 * 60 * 60 * 1000;

// BOM's date param is DD-MM-YYYY. Use UTC components so the URL is deterministic
// in tests; the app over-fetches (1 day back + 7 forward) so a one-day tz slack
// is harmless.
function dmy(date) {
  var d = ('0' + date.getUTCDate()).slice(-2);
  var m = ('0' + (date.getUTCMonth() + 1)).slice(-2);
  return d + '-' + m + '-' + date.getUTCFullYear();
}

// getTidesTable returns one day-table per day starting at `date`, for `days`
// days. region and tz come off the station record (BOM-only fields from
// parseCatalog). tz_js is a display label BOM ignores for the data, left empty.
function hiloUrl(station, from, to) {
  var days = Math.ceil((to.getTime() - from.getTime()) / DAY_MS);
  return TABLE_HOST +
    '?type=tide' +
    '&aac=' + encodeURIComponent(station.id) +
    '&date=' + dmy(from) +
    '&days=' + days +
    '&region=' + encodeURIComponent(station.region) +
    '&offset=0&offsetName=' +
    '&tz=' + encodeURIComponent(station.tz) +
    '&tz_js=';
}
```

Add `hiloUrl: hiloUrl,` and `TABLE_HOST: TABLE_HOST,` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/providers-bom.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pkjs/providers/bom.js test/providers-bom.test.js
git commit -m "feat(bom): hiloUrl builds getTidesTable request"
```

---

## Task 3: BOM `parseHilo` (HTML regex)

**Files:**
- Modify: `src/pkjs/providers/bom.js`
- Test: `test/providers-bom.test.js`

The fixture `test/fixtures/bom-tides-table.html` is a real Hobart capture for 11 Jun 2026. Its four tides, verified, are the expected output below.

- [ ] **Step 1: Write the failing test**

Append to `test/providers-bom.test.js`:

```js
const TABLE_HTML = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'bom-tides-table.html'), 'utf8'
);

test('parseHilo extracts {epoch, heightCm, kind} from the HTML table', () => {
  const pts = bom.parseHilo(TABLE_HTML);
  assert.deepStrictEqual(pts, [
    { epoch: 1781115120, heightCm: 112, kind: 1 },
    { epoch: 1781134620, heightCm: 75, kind: 2 },
    { epoch: 1781159100, heightCm: 149, kind: 1 },
    { epoch: 1781185080, heightCm: 62, kind: 2 },
  ]);
});

test('parseHilo classifies high=1 low=2 from cell class', () => {
  const pts = bom.parseHilo(TABLE_HTML);
  assert.strictEqual(pts[0].kind, 1); // High
  assert.strictEqual(pts[1].kind, 2); // Low
});

test('parseHilo returns [] on non-string / empty / no matches', () => {
  assert.deepStrictEqual(bom.parseHilo(null), []);
  assert.deepStrictEqual(bom.parseHilo(''), []);
  assert.deepStrictEqual(bom.parseHilo('<html>no tides here</html>'), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/providers-bom.test.js`
Expected: FAIL — `bom.parseHilo is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/pkjs/providers/bom.js`, add above `module.exports`:

```js
// getTidesTable returns HTML. Each tide cell carries machine-oriented hooks:
// a <td> with data-time-utc (already UTC ISO) plus a high-tide/low-tide class,
// and a sibling <td class="height high-tide|low-tide">X.XX m</td>. Filler cells
// lack the high/low class and are skipped. We pull the two sequences in document
// order and zip them. Regex, not a DOM lib: PebbleKit JS has no DOMParser and we
// avoid bundling a parser (see spec). Brittleness is pinned by the HTML fixture.
function parseHilo(html) {
  if (typeof html !== 'string') {
    return [];
  }
  var times = [];
  var reTime = /data-time-utc="([^"]+)"[^>]*class="[^"]*(high|low)-tide/g;
  var m;
  while ((m = reTime.exec(html)) !== null) {
    times.push({ iso: m[1], kind: m[2] === 'high' ? 1 : 2 });
  }
  var heights = [];
  var reHeight = /class="height (?:high|low)-tide"[^>]*>\s*([0-9.]+)\s*m/g;
  while ((m = reHeight.exec(html)) !== null) {
    heights.push(Math.round(parseFloat(m[1]) * 100));
  }
  var n = Math.min(times.length, heights.length);
  var out = [];
  for (var i = 0; i < n; i++) {
    out.push({
      epoch: Math.floor(Date.parse(times[i].iso) / 1000),
      heightCm: heights[i],
      kind: times[i].kind,
    });
  }
  return out;
}
```

Add `parseHilo: parseHilo,` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/providers-bom.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pkjs/providers/bom.js test/providers-bom.test.js
git commit -m "feat(bom): parseHilo extracts tides from getTidesTable HTML"
```

---

## Task 4: Declare `responseFormat`/`requestHeaders`, register adapter

**Files:**
- Modify: `src/pkjs/providers/bom.js`
- Modify: `src/pkjs/providers/index.js:7-10`
- Test: `test/providers-bom.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/providers-bom.test.js`:

```js
const registry = require('../src/pkjs/providers');

test('bom declares text responseFormat and a browser User-Agent', () => {
  assert.strictEqual(bom.responseFormat, 'text');
  assert.ok(bom.requestHeaders);
  assert.ok(/Mozilla\/5\.0/.test(bom.requestHeaders['User-Agent']));
});

test('registry routes provider:"bom" to the BOM adapter', () => {
  const adapter = registry.forStation({ provider: 'bom', id: 'TAS_TP003' });
  assert.strictEqual(adapter, bom);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/providers-bom.test.js`
Expected: FAIL — `responseFormat` undefined and/or `Unknown provider "bom"` thrown by `forStation`.

- [ ] **Step 3: Write minimal implementation**

In `src/pkjs/providers/bom.js`, add above `module.exports`:

```js
// BOM blocks non-browser clients (returns "Access Denied") and serves HTML, not
// JSON. The fetch layer (index.js) reads these two flags: responseFormat 'text'
// hands parseHilo the raw response string; requestHeaders are applied to every
// BOM request (catalog and table).
var BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';
```

Add to `module.exports`:

```js
  responseFormat: 'text',
  requestHeaders: { 'User-Agent': BROWSER_UA },
```

In `src/pkjs/providers/index.js`, change the `REGISTRY` (lines 7-10) to:

```js
var REGISTRY = {
  bom: require('./bom'),
  dfo: require('./dfo'),
  noaa: require('./noaa'),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/providers-bom.test.js`
Expected: PASS. Also run `node --test test/providers-pointsfor.test.js` — still PASS (pointsFor routes by provider; BOM now resolvable).

- [ ] **Step 5: Commit**

```bash
git add src/pkjs/providers/bom.js src/pkjs/providers/index.js test/providers-bom.test.js
git commit -m "feat(bom): register adapter; declare text format + browser UA"
```

---

## Task 5: Catalog cache carries `tz`/`region`

`hiloUrl` needs `tz` and `region`. They come from `parseCatalog`, get stored in the cache slice as-is, and must survive `normalizeCatalogRecord` on the way back out. NOAA/DFO records have neither and must be unaffected.

**Files:**
- Modify: `src/pkjs/catalog.js:48-57`
- Test: `test/catalog.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/catalog.test.js` (it already requires the module; reuse its `catalog` binding — if the file names it differently, match that name):

```js
test('unionStations preserves tz/region for BOM records', () => {
  const cache = {
    bom: { stations: [
      { id: 'TAS_TP003', name: 'Hobart', lat: -42.8, lng: 147.3,
        provider: 'bom', tz: 'Australia/Hobart', region: 'TAS' },
    ] },
  };
  const out = catalog.unionStations(cache, []);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].tz, 'Australia/Hobart');
  assert.strictEqual(out[0].region, 'TAS');
  assert.strictEqual(out[0].officialName, 'Hobart');
  assert.strictEqual(out[0].operating, true);
});

test('unionStations omits tz/region for non-BOM records', () => {
  const cache = {
    noaa: { stations: [
      { id: '9447130', name: 'Seattle', lat: 47.6, lng: -122.3, provider: 'noaa' },
    ] },
  };
  const out = catalog.unionStations(cache, []);
  assert.ok(!('tz' in out[0]));
  assert.ok(!('region' in out[0]));
});
```

If `test/catalog.test.js` binds the module under a different variable, check the top of the file and use that name.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/catalog.test.js`
Expected: FAIL — `out[0].tz` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

Replace `normalizeCatalogRecord` in `src/pkjs/catalog.js` (lines 48-57) with:

```js
function normalizeCatalogRecord(rec) {
  var out = {
    id: rec.id,
    officialName: rec.name,
    operating: true,
    latitude: rec.lat,
    longitude: rec.lng,
    provider: rec.provider,
  };
  // BOM-only: hiloUrl needs the station's timezone and region. Carry them
  // through only when present so NOAA/DFO records stay unchanged.
  if (rec.tz != null) {
    out.tz = rec.tz;
  }
  if (rec.region != null) {
    out.region = rec.region;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/catalog.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pkjs/catalog.js test/catalog.test.js
git commit -m "feat(bom): carry tz/region through the catalog cache"
```

---

## Task 6: Fetch layer — raw text, browser headers, BOM in the provider list

`index.js` is the device wiring (uses `XMLHttpRequest`, `Pebble`, `localStorage`, `navigator`). The repo has no unit tests for it; these changes are verified by keeping the whole suite green and by the Phase 3 on-device run. Make the edits exactly.

**Files:**
- Modify: `src/pkjs/index.js` (`fetchJson` 50-68; `fetchWeek` 120-141; `fetchCatalogSlice` 163-185; `onPosition` 230-243; `CATALOG_PROVIDERS` line 13)

- [ ] **Step 1: Add `fetchRaw` and route `fetchJson` through it**

Replace `fetchJson` (lines 50-68) with:

```js
// Low-level GET. headers is an optional { name: value } map applied after open()
// (BOM needs a browser User-Agent or it returns "Access Denied"). Hands back the
// raw responseText so text providers (BOM HTML) and JSON providers share one path.
function fetchRaw(url, headers, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', url, true);
  xhr.timeout = 20000;
  if (headers) {
    Object.keys(headers).forEach(function (name) {
      try {
        xhr.setRequestHeader(name, headers[name]);
      } catch (e) { /* a forbidden header must not kill the request */ }
    });
  }
  xhr.onload = function () {
    if (xhr.status < 200 || xhr.status >= 300) {
      cb('status ' + xhr.status, null);
      return;
    }
    cb(null, xhr.responseText);
  };
  xhr.onerror = function () { cb('network error', null); };
  xhr.ontimeout = function () { cb('timeout', null); };
  xhr.send();
}

function fetchJson(url, cb, headers) {
  fetchRaw(url, headers || null, function (err, text) {
    if (err) {
      cb(err, null);
      return;
    }
    try {
      cb(null, JSON.parse(text));
    } catch (e) {
      cb('parse: ' + e, null);
    }
  });
}
```

- [ ] **Step 2: Branch `fetchWeek` on `responseFormat`**

In `fetchWeek` (lines 120-141), replace the body from `var hiloUrl = ...` through the end of the `fetchJson(...)` call with:

```js
  var adapter = providers.forStation(station);
  var hiloUrl = adapter.hiloUrl(station, from, to);
  var sunDays = sunDaysForWindow(from, to, station);

  // The watch draws a cosine curve between extrema (ADR 0002), so we only need
  // the high/low series. pointsFor routes by provider and owns the response
  // shape (DFO array, NOAA object, BOM HTML string).
  function handle(e1, raw) {
    var points = providers.pointsFor(station, e1, raw);
    if (points.length === 0) {
      console.log('hilo fetch failed (' + e1 + '); keeping cache');
      return;
    }
    var u8 = blob.packWeek(points, station, distanceKm, sunDays);
    sendBlob(u8, station.id, function () {
      writeJson(META_KEY, { date: todayStr(), stationId: station.id, version: blob.BLOB_VERSION });
    });
  }

  if (adapter.responseFormat === 'text') {
    fetchRaw(hiloUrl, adapter.requestHeaders || null, handle);
  } else {
    fetchJson(hiloUrl, handle, adapter.requestHeaders);
  }
```

(`var adapter` replaces the old `providers.forStation(station)` inline call; remove the old `var hiloUrl`, `var sunDays`, and `fetchJson(hiloUrl, function (e1, raw) {...})` lines they replace.)

- [ ] **Step 3: Send headers on the catalog fetch**

In `fetchCatalogSlice` (lines 163-185), change the fetch call from:

```js
    fetchJson(adapter.catalogUrl(), function (err, json) {
```

to:

```js
    fetchJson(adapter.catalogUrl(), function (err, json) {
```

with the headers argument added at the end of that `fetchJson(...)` call — i.e. the closing of the callback becomes:

```js
    }, adapter.requestHeaders);
```

So the BOM catalog request also carries the browser UA. (NOAA/DFO have no `requestHeaders`, so this is a no-op for them.)

- [ ] **Step 4: Persist `tz`/`region` in the remembered station**

In `onPosition` (lines 236-241), replace the `writeJson(LAST_STATION_KEY, {...})` object with one that carries the BOM fields, so a station recovered after a geolocation failure can still build its `hiloUrl`:

```js
  writeJson(LAST_STATION_KEY, {
    id: result.station.id, officialName: result.station.officialName,
    latitude: result.station.latitude, longitude: result.station.longitude,
    operating: result.station.operating, provider: result.station.provider,
    tz: result.station.tz, region: result.station.region,
    distanceKm: result.distanceKm,
  });
```

(`tz`/`region` are `undefined` for NOAA/DFO and serialize away harmlessly.)

- [ ] **Step 5: Add `'bom'` to the catalog provider list**

Change line 13 from:

```js
var CATALOG_PROVIDERS = ['dfo', 'noaa'];
```

to:

```js
var CATALOG_PROVIDERS = ['dfo', 'noaa', 'bom'];
```

- [ ] **Step 6: Verify the whole suite stays green and the file parses**

Run: `node --test test/*.test.js`
Expected: 73 pass, 2 skipped, 0 fail (unchanged).
Run: `node -e "require('./src/pkjs/index.js')" 2>&1 | head` — note this needs Pebble globals and will error on `Pebble`/`navigator`; instead syntax-check with `node --check src/pkjs/index.js` (Expected: no output = parses clean).

- [ ] **Step 7: Commit**

```bash
git add src/pkjs/index.js
git commit -m "feat(bom): fetch layer sends browser UA and raw text; bom in catalog list"
```

---

## Task 7: BOM seed stations

Cold start with no network falls back to the seed. Add a spread of BOM stations so an Australian user offline on first run still gets a nearby station. Values are real, pulled from `tide_prediction_sites.json`.

**Files:**
- Modify: `src/pkjs/stations.js` (append to the exported array, before the closing `];`)

- [ ] **Step 1: Add the seed entries**

Append these objects to the array in `src/pkjs/stations.js` (match the existing one-object-per-line style; mind the trailing comma on the line before them):

```js
  {"provider":"bom","id":"NSW_TP007","officialName":"Sydney (Fort Denison)","operating":true,"latitude":-33.8543,"longitude":151.2253,"tz":"Australia/Sydney","region":"NSW"},
  {"provider":"bom","id":"QLD_TP003","officialName":"Brisbane Bar","operating":true,"latitude":-27.3608,"longitude":153.1719,"tz":"Australia/Brisbane","region":"QLD"},
  {"provider":"bom","id":"WA_TP015","officialName":"Fremantle","operating":true,"latitude":-32.0558,"longitude":115.7395,"tz":"Australia/Perth","region":"WA"},
  {"provider":"bom","id":"TAS_TP003","officialName":"Hobart","operating":true,"latitude":-42.877328,"longitude":147.340953,"tz":"Australia/Hobart","region":"TAS"},
  {"provider":"bom","id":"SA_TP001","officialName":"Port Adelaide (Outer Harbor)","operating":true,"latitude":-34.779761,"longitude":138.480728,"tz":"Australia/Adelaide","region":"SA"},
  {"provider":"bom","id":"NT_TP001","officialName":"Darwin","operating":true,"latitude":-12.4718,"longitude":130.8459,"tz":"Australia/Darwin","region":"NT"}
```

- [ ] **Step 2: Verify it parses and the suite is green**

Run: `node -e "const s=require('./src/pkjs/stations.js'); const b=s.filter(x=>x.provider==='bom'); console.log('bom seeds:', b.length); console.log(b.every(x=>x.tz&&x.region) ? 'all have tz/region' : 'MISSING tz/region');"`
Expected: `bom seeds: 6` and `all have tz/region`.
Run: `node --test test/*.test.js`
Expected: 73 pass, 2 skipped, 0 fail.

- [ ] **Step 3: Commit**

```bash
git add src/pkjs/stations.js
git commit -m "feat(bom): seed Australian stations for offline cold start"
```

---

## Task 8: End-to-end on device (Phase 3)

Confirms the live BOM endpoints answer with the browser UA, the nearest Australian station is selected, the curve draws, and tide stepping works. This is where the User-Agent assumption gets proven.

**Files:** none (manual verification). Uses the geo-override technique from project memory (patch pypkjs `geolocation.py` to force a location; allow ~40s settle).

- [ ] **Step 1: Build the app**

Run the project build (see README). Expected: clean build for gabbro.

- [ ] **Step 2: Force the emulator to an Australian location**

Patch pypkjs geolocation to Hobart (`-42.88, 147.33`) per the geo-override memory note. Restart so PebbleKit JS re-reads location.

- [ ] **Step 3: Observe selection + fetch in the JS console**

Expected logs: a `bom` catalog cached line with a station count in the hundreds; nearest station resolves to a Tasmanian BOM station (e.g. Hobart); no "Access Denied"; a blob sent to the watch.
If you see "Access Denied" or an empty parse, the on-device `User-Agent` was stripped — stop and revisit the data source (spec risk #2).

- [ ] **Step 4: Verify the watch UI**

Expected: today's high/low times and the tide curve render for the Australian station; DOWN steps to the next tide, UP to the previous (matching NOAA/DFO behavior).

- [ ] **Step 5: Confirm no regression for the existing providers**

Re-point the geo-override to Seattle (`47.6, -122.3`) and Vancouver (`49.28, -123.12`); confirm NOAA and DFO stations still select and render. Restore geolocation.

- [ ] **Step 6: Final suite + commit any fixup**

Run: `node --test test/*.test.js`
Expected: 73 pass, 2 skipped, 0 fail.
Commit any small fixes uncovered during e2e with a clear message.

---

## Self-Review

**Spec coverage:**
- New `bom.js` four functions → Tasks 1-3. ✓
- Catalog from `tide_prediction_sites.json`, keep `AVAIL_FLAG==='Y'`, all 737 (no state filter) → Task 1. ✓
- `hiloUrl` with `date`/`days`/`region`/`tz` → Task 2. ✓
- `parseHilo` regex (the decided approach), pinned by real HTML fixture → Task 3. ✓
- `responseFormat: 'text'` + text branch in fetch layer → Tasks 4, 6. ✓
- Browser User-Agent on BOM requests (catalog + table) → Tasks 4, 6. ✓
- `tz`/`region` through the catalog cache → Task 5; and through the remembered-station fallback → Task 6 Step 4. ✓
- Register `bom`, add to `CATALOG_PROVIDERS`, seed stations → Tasks 4, 6, 7. ✓
- Geo/cache/blob/C-app untouched → confirmed; no tasks touch them. ✓
- Phase 3 end-to-end with Australian geo-override → Task 8. ✓
- Out of scope (streams/offsets, user override, replacing NOAA/DFO) → no tasks. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; expected values in Task 3 are real (computed from the committed fixture).

**Type consistency:** `parseCatalog` emits `{ id, name, lat, lng, provider, tz, region }`; `normalizeCatalogRecord` reads `rec.tz`/`rec.region` and emits `tz`/`region`; `hiloUrl` reads `station.region`/`station.tz`; seed objects and `LAST_STATION_KEY` carry `tz`/`region`. Names line up across Tasks 1, 2, 5, 6, 7. `responseFormat`/`requestHeaders` defined in Task 4 are read in Task 6. Consistent.
