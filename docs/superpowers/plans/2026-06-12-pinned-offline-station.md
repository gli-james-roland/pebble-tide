# Pinned Offline Station Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user pin a tide station for a place they'll visit (by typing a place name), download up to 45 days of predictions while online, and view them offline on arrival.

**Architecture:** Mostly PebbleKit JS. The config page gains a "Tide location" section (Auto vs Pin-a-place + a 7/15/30/45 day range). On Save, PKJS geocodes the place (OSM Nominatim), runs the existing `geo.nearestUsableStation` to pick the **Pinned Station**, fetches the chosen **Offline Range**, and sends it to the watch. In Pinned Mode the launch flow skips geolocation and refreshes the pinned station when online. The watch's blob caps grow to hold 45 days; this forces relocating the config persist keys to avoid colliding with the larger blob's chunk fields.

**Tech Stack:** PebbleKit JS (CommonJS, ES5 style), Pebble C, Node `node --test`, OSM Nominatim geocoder.

**Design docs:** [ADR 0004](../../adr/0004-pinned-offline-station-by-geocoded-place.md) (selection by geocoded place), [ADR 0005](../../adr/0005-offline-download-sizing.md) (45-day sizing), [CONTEXT.md](../../../CONTEXT.md) (Pinned Station, Offline Range, Auto/Pinned Mode).

**Test command:** `node --test test/*.test.js` — baseline 88 pass, 2 skipped, 0 fail. C compiles with `pebble build`.

---

## File Structure

- **Modify** `src/c/pebble_tides.c` — relocate config persist keys (collision fix) + bump blob caps.
- **Create** `src/pkjs/pin.js` — Pinned Station state (read/write/clear/parse). One responsibility: the pin record.
- **Create** `src/pkjs/geocode.js` — place → coordinates via Nominatim (URL builder + parser + XHR glue).
- **Modify** `src/pkjs/config.js` — render the "Tide location" section + current-pin line; the page returns location fields.
- **Modify** `src/pkjs/index.js` — generalize the fetch to N forward days; route Save → geocode → pin → download; pinned launch path.
- **Create** `test/pin.test.js`, `test/geocode.test.js`, `test/config.test.js` — unit tests for the pure modules.

Contracts:
- `pin` record: `{ mode:'auto'|'pinned', place:string, station:object|null, rangeDays:number, distanceKm:number, error:string|null }`.
- `geocode.geocode(place, cb)` → `cb({lat, lon})` or `cb(null)` on any failure.
- A pinned `station` carries the same shape the rest of the pipeline expects: `{ id, officialName, latitude, longitude, operating, provider, tz, region }`.

---

## Task 1: Relocate config persist keys (collision fix)

Bumping the blob to 3072 bytes makes it occupy persist chunk keys `11..22`, which collides with the config keys at `20/21/22`. Move config to `40/41/42` first, with a one-time migration that reads the old keys so existing users keep their settings.

**Files:**
- Modify: `src/c/pebble_tides.c:29-31` (defines), `:191-198` (`prv_load_config`), `:672-674` (inbox writes)

- [ ] **Step 1: Relocate the key defines**

Change `src/c/pebble_tides.c:29-31` from:

```c
#define PERSIST_CONFIG_UNITS 20
#define PERSIST_CONFIG_CLOCK 21
#define PERSIST_CONFIG_MIDTIDE 22
```

to:

```c
// Config keys live above the blob's chunk range. The blob occupies
// PERSIST_BLOB_BASE (11) .. 11+ceil(MAX_BLOB_BYTES/256)-1; at 3072 bytes that is
// 11..22, so config moved from 20/21/22 to 40/41/42 (migration in prv_load_config).
#define PERSIST_CONFIG_UNITS 40
#define PERSIST_CONFIG_CLOCK 41
#define PERSIST_CONFIG_MIDTIDE 42
#define PERSIST_CONFIG_UNITS_OLD 20
#define PERSIST_CONFIG_CLOCK_OLD 21
#define PERSIST_CONFIG_MIDTIDE_OLD 22
```

- [ ] **Step 2: Add migration in `prv_load_config`**

Replace the body of `prv_load_config` (`src/c/pebble_tides.c:191-198`) with:

```c
// Read a config int from new_key; if absent, migrate from the pre-3072-blob
// old_key (and copy it forward) so the larger blob can reclaim 20/21/22.
static int prv_config_int(uint32_t new_key, uint32_t old_key, int dflt) {
  if (persist_exists(new_key)) {
    return persist_read_int(new_key);
  }
  if (persist_exists(old_key)) {
    int v = persist_read_int(old_key);
    persist_write_int(new_key, v);
    return v;
  }
  return dflt;
}

static void prv_load_config(void) {
  s_units = prv_config_int(PERSIST_CONFIG_UNITS, PERSIST_CONFIG_UNITS_OLD, UNITS_FEET);
  s_clock = prv_config_int(PERSIST_CONFIG_CLOCK, PERSIST_CONFIG_CLOCK_OLD, CLOCK_12H);
  s_show_midtide = prv_config_int(PERSIST_CONFIG_MIDTIDE, PERSIST_CONFIG_MIDTIDE_OLD, 0);
}
```

- [ ] **Step 3: Inbox writes use the new keys**

The writes at `src/c/pebble_tides.c:672-674` already reference `PERSIST_CONFIG_UNITS/CLOCK/MIDTIDE`, which now resolve to 40/41/42 — no edit needed. Confirm by reading those three lines; they should be:

```c
  persist_write_int(PERSIST_CONFIG_UNITS, s_units);
  persist_write_int(PERSIST_CONFIG_CLOCK, s_clock);
  persist_write_int(PERSIST_CONFIG_MIDTIDE, s_show_midtide);
```

- [ ] **Step 4: Build + verify**

Run: `pebble build`
Expected: `'build' finished successfully` (RWX-segment linker warnings are pre-existing and fine).
Run: `node --check src/pkjs/index.js` (no C test harness exists; the watch C is verified by build + the Phase E emulator run).

- [ ] **Step 5: Commit**

```bash
git add src/c/pebble_tides.c
git commit -m "fix(watch): relocate config persist keys to 40-42 (clear blob chunk range)"
```

---

## Task 2: Bump blob caps for 45 days

**Files:**
- Modify: `src/c/pebble_tides.c:12-14`

- [ ] **Step 1: Raise the caps**

Change `src/c/pebble_tides.c:12-14` from:

```c
#define MAX_BLOB_BYTES 2048
#define MAX_POINTS 256
```
```c
#define MAX_SUN_DAYS 16          // per-day sunrise/sunset; window is ~9 days
```

to:

```c
#define MAX_BLOB_BYTES 3072      // holds a 45-day Offline Range (ADR 0005); 12 persist
                                 // chunks at keys 11..22 (config relocated to 40+)
#define MAX_POINTS 320           // 45 days at up to ~7 extrema/day
```
```c
#define MAX_SUN_DAYS 48          // 45 forward + 1 back + margin of night shading
```

(Keep `MAX_BLOB_BYTES` and `MAX_POINTS` adjacent as they are now; the `MAX_SUN_DAYS` line is separate at :14.)

- [ ] **Step 2: Build + verify the chunk math**

Run: `pebble build`
Expected: success. 3072 / 256 = 12 chunks → keys 11..22; config now at 40..42, so no overlap.

- [ ] **Step 3: Commit**

```bash
git add src/c/pebble_tides.c
git commit -m "feat(watch): raise blob caps to hold a 45-day offline range"
```

---

## Task 3: `pin.js` — Pinned Station state

**Files:**
- Create: `src/pkjs/pin.js`
- Test: `test/pin.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/pin.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const pin = require('../src/pkjs/pin');

function fakeStorage() {
  const m = {};
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; }, removeItem: (k) => { delete m[k]; } };
}

test('read returns auto mode when nothing stored', () => {
  assert.deepStrictEqual(pin.read(fakeStorage()), { mode: 'auto' });
});

test('write then read round-trips a pinned record', () => {
  const s = fakeStorage();
  const rec = { mode: 'pinned', place: 'Hobart', station: { id: 'TAS_TP003' }, rangeDays: 30, distanceKm: 8, error: null };
  pin.write(s, rec);
  assert.deepStrictEqual(pin.read(s), rec);
});

test('clear returns to auto and removes the record', () => {
  const s = fakeStorage();
  pin.write(s, { mode: 'pinned', place: 'X', rangeDays: 7 });
  assert.deepStrictEqual(pin.clear(s), { mode: 'auto' });
  assert.deepStrictEqual(pin.read(s), { mode: 'auto' });
});

test('normalizeRange snaps invalid values to the default', () => {
  assert.strictEqual(pin.normalizeRange(15), 15);
  assert.strictEqual(pin.normalizeRange(99), pin.DEFAULT_RANGE);
  assert.strictEqual(pin.normalizeRange(undefined), pin.DEFAULT_RANGE);
});

test('parseResponse extracts location fields from the config JSON', () => {
  const r = pin.parseResponse(JSON.stringify({ units: 1, locationMode: 'pinned', place: '  Sydney  ', range: 45 }));
  assert.deepStrictEqual(r, { mode: 'pinned', place: 'Sydney', rangeDays: 45 });
});

test('parseResponse defaults to auto and trims; returns null on garbage', () => {
  assert.strictEqual(pin.parseResponse('{').valueOf === undefined ? null : pin.parseResponse('{'), null);
  assert.strictEqual(pin.parseResponse(JSON.stringify({})).mode, 'auto');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pin.test.js`
Expected: FAIL — `Cannot find module '../src/pkjs/pin'`.

- [ ] **Step 3: Write the implementation**

Create `src/pkjs/pin.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pin.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pkjs/pin.js test/pin.test.js
git commit -m "feat(pkjs): pin state module (read/write/clear/parse)"
```

---

## Task 4: `geocode.js` — place to coordinates

**Files:**
- Create: `src/pkjs/geocode.js`
- Test: `test/geocode.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/geocode.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const geocode = require('../src/pkjs/geocode');

test('geocodeUrl builds a Nominatim query with limit=1', () => {
  const url = geocode.geocodeUrl('Hobart, TAS');
  assert.ok(url.indexOf('nominatim.openstreetmap.org/search') !== -1, url);
  assert.ok(url.indexOf('format=json') !== -1);
  assert.ok(url.indexOf('limit=1') !== -1);
  assert.ok(url.indexOf('q=Hobart%2C%20TAS') !== -1, url);
});

test('parseGeocode returns lat/lon from the first result', () => {
  const json = [{ lat: '-42.8821', lon: '147.3272', display_name: 'Hobart' }];
  assert.deepStrictEqual(geocode.parseGeocode(json), { lat: -42.8821, lon: 147.3272 });
});

test('parseGeocode returns null on empty/garbage/missing coords', () => {
  assert.strictEqual(geocode.parseGeocode([]), null);
  assert.strictEqual(geocode.parseGeocode(null), null);
  assert.strictEqual(geocode.parseGeocode([{ lat: 'x', lon: 'y' }]), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/geocode.test.js`
Expected: FAIL — `Cannot find module '../src/pkjs/geocode'`.

- [ ] **Step 3: Write the implementation**

Create `src/pkjs/geocode.js`:

```js
'use strict';

// Geocode a place name to coordinates via OSM Nominatim (ADR 0004). No API key;
// Nominatim's usage policy requires an identifying User-Agent and is fine for
// the occasional, user-initiated lookup this app does. geocodeUrl/parseGeocode
// are pure and unit-tested; geocode() is the XHR glue.

var NOMINATIM = 'https://nominatim.openstreetmap.org/search';
var USER_AGENT = 'pebble_tides (https://github.com/gli-james-roland/pebble-tide)';

function geocodeUrl(place) {
  return NOMINATIM + '?format=json&limit=1&q=' + encodeURIComponent(place);
}

function parseGeocode(json) {
  if (!Array.isArray(json) || json.length === 0) {
    return null;
  }
  var top = json[0];
  var lat = parseFloat(top.lat);
  var lon = parseFloat(top.lon);
  if (isNaN(lat) || isNaN(lon)) {
    return null;
  }
  return { lat: lat, lon: lon };
}

// geocode(place, cb): cb({lat, lon}) on success, cb(null) on any failure.
function geocode(place, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', geocodeUrl(place), true);
  xhr.timeout = 15000;
  try { xhr.setRequestHeader('User-Agent', USER_AGENT); } catch (e) { /* forbidden header must not abort */ }
  xhr.onload = function () {
    if (xhr.status < 200 || xhr.status >= 300) { cb(null); return; }
    try { cb(parseGeocode(JSON.parse(xhr.responseText))); }
    catch (e) { cb(null); }
  };
  xhr.onerror = function () { cb(null); };
  xhr.ontimeout = function () { cb(null); };
  xhr.send();
}

module.exports = { geocodeUrl: geocodeUrl, parseGeocode: parseGeocode, geocode: geocode, NOMINATIM: NOMINATIM };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/geocode.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pkjs/geocode.js test/geocode.test.js
git commit -m "feat(pkjs): geocode places via Nominatim (url builder + parser + xhr)"
```

---

## Task 5: Config page — "Tide location" section

**Files:**
- Modify: `src/pkjs/config.js` (`pageUrl`)
- Test: `test/config.test.js`

`pageUrl` becomes `pageUrl(pinRec)` so it can pre-fill the place/range and show the current pin. The page returns `locationMode`, `place`, `range` alongside the existing display fields.

- [ ] **Step 1: Write the failing test**

Create `test/config.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../src/pkjs/config');

test('pageUrl renders the Tide location section with range options', () => {
  const url = config.pageUrl({ mode: 'auto' });
  const html = decodeURIComponent(url.replace('data:text/html;charset=utf-8,', ''));
  assert.ok(html.indexOf('Tide location') !== -1);
  assert.ok(html.indexOf('name="locationMode"') !== -1);
  assert.ok(html.indexOf('name="place"') !== -1);
  [7, 15, 30, 45].forEach((d) => assert.ok(html.indexOf('value="' + d + '"') !== -1, 'range ' + d));
});

test('pageUrl shows the current pin and pre-selects pinned mode', () => {
  const url = config.pageUrl({ mode: 'pinned', place: 'Hobart', rangeDays: 30, distanceKm: 8, station: { officialName: 'Hobart' } });
  const html = decodeURIComponent(url.replace('data:text/html;charset=utf-8,', ''));
  assert.ok(html.indexOf('Pinned: Hobart') !== -1, 'shows resolved station');
  assert.ok(html.indexOf('8 km') !== -1, 'shows distance');
});

test('pageUrl shows a pin error when present', () => {
  const url = config.pageUrl({ mode: 'pinned', place: 'Nowhere', rangeDays: 15, station: null, error: "Couldn't find \"Nowhere\"" });
  const html = decodeURIComponent(url.replace('data:text/html;charset=utf-8,', ''));
  assert.ok(html.indexOf("Couldn't find") !== -1);
});

test('pageUrl tolerates a missing pin record (auto default)', () => {
  const url = config.pageUrl();
  assert.ok(url.indexOf('data:text/html') === 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL — `pageUrl` ignores its argument; "Tide location" not found (and/or pinned assertions fail).

- [ ] **Step 3: Implement**

In `src/pkjs/config.js`, change the `pageUrl` signature and add the location section. Replace `function pageUrl() {` with:

```js
function pageUrl(pinRec) {
  var pinned = pinRec && pinRec.mode === 'pinned';
  var place = (pinRec && pinRec.place) || '';
  var range = (pinRec && pinRec.rangeDays) || 15;
  var status = '';
  if (pinned && pinRec.station) {
    status = '<p class="sub">Pinned: ' + (pinRec.station.officialName || '?') +
      ' — ~' + (pinRec.distanceKm || 0) + ' km from "' + place + '"</p>';
  } else if (pinned && pinRec.error) {
    status = '<p class="sub" style="color:#c00">' + pinRec.error + '</p>';
  }
  var rangeInputs = [7, 15, 30, 45].map(function (d) {
    return '<label><input type="radio" name="range" value="' + d + '"' +
      (range === d ? ' checked' : '') + '>' + d + ' days</label>';
  }).join('');
```

Then, inside the existing HTML string, insert the location fieldset just before the `'<button id="save">Save</button>'` line:

```js
    '<fieldset><legend>Tide location</legend>' + status +
    '<label><input type="radio" name="locationMode" value="auto"' + (pinned ? '' : ' checked') + '>Use my location</label>' +
    '<label><input type="radio" name="locationMode" value="pinned"' + (pinned ? ' checked' : '') + '>Pin a place for offline</label>' +
    '<label>Place: <input type="text" name="place" value="' + place.replace(/"/g, '&quot;') + '" placeholder="e.g. Tofino BC"></label>' +
    rangeInputs +
    '</fieldset>' +
```

And extend the page's save script so the returned object includes the location fields. Change the `var out={...}` line to:

```js
    'var out={units:pick("units"),clock:pick("clock"),midtide:pick("midtide"),' +
    'locationMode:(function(){var e=document.getElementsByName("locationMode");' +
    'for(var i=0;i<e.length;i++){if(e[i].checked)return e[i].value;}return "auto";})(),' +
    'place:document.getElementsByName("place")[0].value,range:pick("range")};' +
```

Keep the existing `pick()` helper for `units/clock/midtide/range`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pkjs/config.js test/config.test.js
git commit -m "feat(pkjs): config page gains Tide location section + current-pin status"
```

---

## Task 6: Generalize the fetch to N forward days

**Files:**
- Modify: `src/pkjs/index.js` (`fetchWeek` 120-141; `maybeRefresh` 143-150)

- [ ] **Step 1: Add `fetchRange` and make `fetchWeek`/`maybeRefresh` use it**

Replace `fetchWeek` (`src/pkjs/index.js:120-141`) with a `fetchRange(station, distanceKm, forwardDays)` that takes the forward-day count, and a thin `fetchWeek` wrapper:

```js
function fetchRange(station, distanceKm, forwardDays) {
  var now = new Date();
  var from = new Date(now.getTime() - BACK_DAYS * 24 * 60 * 60 * 1000);
  var to = new Date(now.getTime() + forwardDays * 24 * 60 * 60 * 1000);
  var adapter = providers.forStation(station);
  var hiloUrl = adapter.hiloUrl(station, from, to);
  var sunDays = sunDaysForWindow(from, to, station);

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
}

function fetchWeek(station, distanceKm) {
  fetchRange(station, distanceKm, WEEK_DAYS);
}
```

- [ ] **Step 2: Let `maybeRefresh` take an optional day count**

Replace `maybeRefresh` (`src/pkjs/index.js:143-150`) with:

```js
function maybeRefresh(station, distanceKm, forwardDays) {
  var days = forwardDays || WEEK_DAYS;
  if (refresh.shouldRefresh(todayStr(), station.id, blob.BLOB_VERSION, readJson(META_KEY))) {
    console.log('Refreshing ' + days + ' days for ' + station.officialName);
    fetchRange(station, distanceKm, days);
  } else {
    console.log('Cache is fresh for ' + station.officialName + '; not fetching');
  }
}
```

(Existing `onPosition`/`onPositionError` calls `maybeRefresh(station, dist)` — `forwardDays` is `undefined` → defaults to `WEEK_DAYS`, unchanged behaviour.)

- [ ] **Step 3: Verify**

Run: `node --check src/pkjs/index.js` (Expected: parses clean.)
Run: `node --test test/*.test.js` (Expected: unchanged totals — index.js is untested; suite must stay green.)

- [ ] **Step 4: Commit**

```bash
git add src/pkjs/index.js
git commit -m "refactor(pkjs): fetchRange(forwardDays); fetchWeek/maybeRefresh wrap it"
```

---

## Task 7: Save → geocode → pin → download

**Files:**
- Modify: `src/pkjs/index.js` (requires at top ~8-11; `webviewclosed` handler ~307-310; `showConfiguration` ~300-302)

- [ ] **Step 1: Require the new modules**

After `var catalog = require('./catalog');` (`src/pkjs/index.js:9`), add:

```js
var pin = require('./pin');
var geocode = require('./geocode');
```

- [ ] **Step 2: Pass the pin record to the config page**

Replace the `showConfiguration` handler (`src/pkjs/index.js:300-302`):

```js
Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(config.pageUrl(pin.read(localStorage)));
});
```

- [ ] **Step 3: Route the Save response**

Replace the `webviewclosed` handler (`src/pkjs/index.js:307-310`) with:

```js
Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) { return; }     // user cancelled
  config.save(e.response);
  sendConfig();

  var loc = pin.parseResponse(e.response);
  if (!loc) { return; }

  if (loc.mode === 'auto') {
    pin.clear(localStorage);
    locate();                            // resume Auto immediately
    return;
  }
  if (!loc.place) {
    pin.write(localStorage, { mode: 'pinned', place: '', station: null, rangeDays: loc.rangeDays, distanceKm: 0, error: 'No place entered' });
    return;
  }
  // Pinned: geocode the place, pick the nearest Usable Station, download the range.
  geocode.geocode(loc.place, function (coords) {
    if (!coords) {
      pin.write(localStorage, { mode: 'pinned', place: loc.place, station: null, rangeDays: loc.rangeDays, distanceKm: 0, error: 'Couldn\'t find "' + loc.place + '"' });
      return;
    }
    var result = selectStation(coords.lat, coords.lon);
    if (!result) {
      pin.write(localStorage, { mode: 'pinned', place: loc.place, station: null, rangeDays: loc.rangeDays, distanceKm: 0, error: 'No station found near "' + loc.place + '"' });
      return;
    }
    var st = result.station;
    pin.write(localStorage, {
      mode: 'pinned', place: loc.place, rangeDays: loc.rangeDays, distanceKm: result.distanceKm, error: null,
      station: { id: st.id, officialName: st.officialName, latitude: st.latitude, longitude: st.longitude, operating: st.operating, provider: st.provider, tz: st.tz, region: st.region },
    });
    fetchRange(st, result.distanceKm, loc.rangeDays);
  });
});
```

- [ ] **Step 4: Verify**

Run: `node --check src/pkjs/index.js` (Expected: clean.)
Run: `node --test test/*.test.js` (Expected: green; new module tests included.)

- [ ] **Step 5: Commit**

```bash
git add src/pkjs/index.js
git commit -m "feat(pkjs): Save pins a place — geocode, nearest station, download range"
```

---

## Task 8: Pinned launch path (skip geolocation)

**Files:**
- Modify: `src/pkjs/index.js` (`ready` handler ~285-298)

- [ ] **Step 1: Branch the launch flow on the pin**

Replace the `ready` handler (`src/pkjs/index.js:285-298`) with:

```js
Pebble.addEventListener('ready', function () {
  console.log('pebble_tides pkjs ready');
  sendConfig();

  var p = pin.read(localStorage);
  if (p.mode === 'pinned' && p.station) {
    // Pinned Mode (ADR 0004/0005): no geolocation. Refresh the pinned station's
    // range when online; fetchRange keeps the stored snapshot on failure (offline).
    console.log('Pinned to ' + p.station.officialName + ' (' + p.rangeDays + 'd)');
    maybeRefresh(p.station, p.distanceKm || 0, p.rangeDays);
    return;
  }

  var cache = catalog.readCache(localStorage);
  if (!orchestrate.hasAnyCache(cache)) {
    coldStartThenLocate();
  } else {
    locate();
    backgroundRefreshCatalogs(cache);
  }
});
```

- [ ] **Step 2: Verify**

Run: `node --check src/pkjs/index.js` (Expected: clean.)
Run: `node --test test/*.test.js` (Expected: green.)

- [ ] **Step 3: Commit**

```bash
git add src/pkjs/index.js
git commit -m "feat(pkjs): pinned launch skips geolocation, refreshes the pinned range"
```

---

## Task 9: End-to-end on device (needs emulator)

Verifies the whole flow. Uses `make emu-australia` etc. and the phone-app config page (the emulator opens config via the developer connection / `pebble emu-app-config`).

**Files:** none (manual verification).

- [ ] **Step 1: Build + install**

Run: `pebble build && pebble install --emulator gabbro`. Expected: clean build, app runs.

- [ ] **Step 2: Open config and pin a place**

Run: `pebble emu-app-config --emulator gabbro` (opens the config page in a browser). Choose "Pin a place for offline", enter `Hobart, TAS`, range 30, Save.
Expected (JS console / `pebble logs`): a geocode request, then `bom catalog`/nearest resolves a Tasmanian station, then a blob sent. Watch shows **Hobart**.

- [ ] **Step 3: Confirm the pin is shown**

Reopen config (`pebble emu-app-config`). Expected: "Pinned: Hobart — ~N km from 'Hobart, TAS'" and pinned mode pre-selected, range 30 checked.

- [ ] **Step 4: Verify offline persistence**

Kill + relaunch the app without changing the (forced) geolocation. Expected: launch logs "Pinned to Hobart"; no geolocation; watch still shows Hobart's tides. Step DOWN/UP across many days to confirm the longer window is present.

- [ ] **Step 5: Toggle back to Auto**

Open config, choose "Use my location", Save. Expected: pin cleared; the app geolocates and shows the nearest station again.

- [ ] **Step 6: Final suite + commit any fixup**

Run: `node --test test/*.test.js` (Expected: green.) Commit any small fixes from e2e.

---

## Self-Review

**Spec/ADR coverage:**
- Pinned Station overrides Auto, single tracked station → Tasks 7, 8. ✓
- Selection by typed place → geocode → `nearestUsableStation` (ADR 0004) → Tasks 4, 7. ✓
- Offline Range 7/15/30/45, Pinned-only → Tasks 3 (RANGES), 5 (UI), 6 (forwardDays), 7 (download). ✓
- Refresh-on-launch when online, snapshot offline → Task 8 (`maybeRefresh` reuses keep-cache-on-failure). ✓
- Config UX: one page, mode radio doubles as clear, Save triggers download → Tasks 5, 7. ✓
- Confirm-after: watch name + far-warning (existing) + config "Pinned: X" line → Task 5 (status line); far-warning is existing blob `flags` behaviour, unchanged. ✓
- Blob sizing 320/48/3072 within 4 KB (ADR 0005) → Task 2. ✓
- Persist-key collision from the bigger blob → Task 1 (relocate + migrate). ✓
- BOM year-end clamp → no task needed (the Range fetch's `to` is clamped by BOM's response; `fetchRange` handles a short series via the existing empty/short-points path). ✓
- Geocode failure / no station / no place → Task 7 error branches. ✓

**Placeholder scan:** none — every step has complete code or an exact edit + command.

**Type consistency:** `pin` record fields (`mode/place/station/rangeDays/distanceKm/error`) match across Tasks 3, 5, 7, 8. `parseResponse` returns `{mode, place, rangeDays}` (consumed in Task 7). `geocode(place, cb)` → `{lat, lon}`/`null` (Task 4) matches the caller in Task 7. `fetchRange(station, distanceKm, forwardDays)` defined in Task 6, called in Tasks 6/7/8. `pageUrl(pinRec)` defined in Task 5, called in Task 7. Config page returns `locationMode/place/range`, parsed by `pin.parseResponse` (`locationMode`→`mode`, `range`→`rangeDays`). Consistent.
