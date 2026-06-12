# Add Australia (BOM) as a third tide provider

Date: 2026-06-11
Status: Draft — awaiting review

## Goal

Show tide predictions and auto-select the nearest station for Australia, the
South Pacific, and Antarctica, using the Bureau of Meteorology (BOM) as a third
data provider alongside NOAA (US) and DFO (Canada).

A user in Sydney, Brisbane, Perth, or Hobart opens the watchapp and sees the
day's high/low times and curve for the nearest BOM station, the same way a user
in Seattle gets NOAA or a user in Vancouver gets DFO.

## Why BOM, and what it costs

BOM is the official national source: 737 prediction sites across Australia, the
South Pacific, Antarctica, and nearby nations. It is free and needs no API key.

BOM publishes no documented JSON API. Two BOM endpoints carry what we need, and
both have sharp edges:

- The site loads one master catalog GeoJSON,
  `https://www.bom.gov.au/australia/tides/tide_prediction_sites.json`
  (737 features, ~360 KB), with `AAC` code, `LAT`/`LON`, `STATE_CODE`,
  `TIME_ZONE`, and `AVAIL_FLAG` per site. This is a richer catalog than NOAA or
  DFO — it carries the timezone the prediction endpoint needs.
- `https://www.bom.gov.au/australia/tides/scripts/getTidesTable.php` returns a
  multi-day high/low table. With `days=8` it returns eight day-tables, enough
  for the app's 1-day-back + 7-day-forward window.

The costs we accept by choosing BOM:

1. **The prediction endpoint returns HTML, not JSON.** Times come as
   `data-time-utc="2026-06-10T19:19:00Z"` attributes (already UTC ISO, no tz
   math), high/low as cell classes `high-tide`/`low-tide`, heights as
   `2.38 m` text. Parseable by regex; no DOM parser needed on the phone.
2. **BOM blocks non-browser clients.** Requests need a browser `User-Agent`
   header or BOM returns "Access Denied". Confirmed from `curl`.
3. **Tide-table reuse terms.** BOM applies conditions to tide-table reuse.
   Review before shipping to the store.

## Architecture

The codebase already has a provider registry seam. Each provider is a module
exporting four functions, routed by a `station.provider` string tag:

```js
{
  catalogUrl(),            // -> URL string for the station catalog
  parseCatalog(json),      // -> [{ id, name, lat, lng, provider }, ...]
  hiloUrl(station, from, to), // -> URL string for high/low predictions
  parseHilo(raw),          // -> [{ epoch, heightCm, kind }, ...]
}
```

Adding BOM means one new module plus three small touches: register it, list it
as a catalog provider, and teach the fetch layer to hand a provider raw text
instead of parsed JSON.

### New module: `src/pkjs/providers/bom.js`

| Function | Behavior |
| --- | --- |
| `catalogUrl()` | Returns `https://www.bom.gov.au/australia/tides/tide_prediction_sites.json`. |
| `parseCatalog(json)` | GeoJSON `FeatureCollection`. For each feature with `properties.AVAIL_FLAG === 'Y'`, emit `{ id: AAC, name: PORT_NAME, lat: LAT, lng: LON, provider: 'bom', tz: TIME_ZONE, region: STATE_CODE }`. No state filter — keep all 737. Return `[]` on null/non-object/missing `features`; never throw. |
| `hiloUrl(station, from, to)` | Build `getTidesTable.php?type=tide&aac={id}&date={DD-MM-YYYY of from}&days={daySpan}&region={region}&offset=0&offsetName=&tz={tz}&tz_js=`. `daySpan` = whole days from `from` to `to`, rounded up (8 for the standard window). Reads `station.region` and `station.tz`. |
| `parseHilo(raw)` | `raw` is the HTML string. Regex-extract each tide cell: `data-time-utc` → `epoch` (`Date.parse / 1000`), cell class `high-tide`/`low-tide` → `kind` (1 high, 2 low), height `X.XX m` → `heightCm` (`round(metres * 100)`). Already classified by BOM — no `classifyExtrema`. Return `[]` on empty/no matches; never throw. |

`parseHilo` returns `kind` 1/2 only (BOM gives no plain hourly samples), matching
the existing 0/1/2 contract the C app consumes.

#### Decision: regex, not an HTML parser library

`parseHilo` scans the HTML with regex, not a DOM/parser dependency.

- **No DOM on-device.** PebbleKit JS has no `DOMParser`. A parser means
  bundling `htmlparser2`/`cheerio` into the watchapp JS, which ships to the
  phone against a tight budget. The codebase has zero HTML-parse dependencies
  today.
- **Same brittleness floor.** Both approaches key off the same machine-oriented
  hooks BOM exposes: `data-time-utc`, the `high-tide`/`low-tide` classes, and
  the `X.XX m` height text. If BOM renames any of those, regex and parser break
  equally. A parser only wins against pure *structural* change (more nesting or
  whitespace) that keeps the selectors.
- **The hard part is shared.** Time+kind sit in one `<td>`; height sits in a
  sibling `<td>`. Pairing them means walking document order and zipping —
  identical work under a parser.

Robustness comes from how the regex is written, not from a library:

1. Match self-contained tokens. One pass pulls `data-time-utc` and the class
   from the *same* tag (time and kind together, no adjacency assumption). A
   second pass pulls `class="height …"` cells with their `X.XX m`. Zip the two
   sequences in document order.
2. Anchor only on semantic attributes and classes, never on whitespace or
   attribute order.
3. Pin behavior with a real captured BOM HTML fixture in the test suite. Any
   BOM markup change that breaks extraction fails CI loudly instead of shipping
   silent-wrong tides.

### Catalog record carries `tz` and `region`

NOAA and DFO stations need only `{ id, name, lat, lng, provider }`. BOM's
`hiloUrl` also needs `tz` and `region`. These two fields must survive into the
cached catalog slice and back out through `unionStations` /
`normalizeCatalogRecord`, so a station selected from cache still has them when
`hiloUrl` runs.

Change: `normalizeCatalogRecord` (and the trim step in `parseCatalog`
consumers) preserve optional `tz` and `region` when present. NOAA/DFO records
omit them and are unaffected.

### Fetch layer: text vs JSON

`index.js` currently fetches and `JSON.parse`s every provider response before
handing it to `parseHilo`. BOM returns HTML.

Change: each adapter declares `responseFormat: 'json' | 'text'` (default
`'json'`). The fetch path branches once: `'text'` providers get the raw response
string, `'json'` providers get the parsed object, exactly as today. NOAA and DFO
set nothing and keep current behavior.

The catalog fetch stays JSON for all three (BOM's catalog is JSON).

### Browser User-Agent header

The fetch for BOM URLs must set a browser `User-Agent`, or BOM returns "Access
Denied". We assume PebbleKit JS allows setting `User-Agent` on an
`XMLHttpRequest` (it has historically). The fetch layer sets a browser UA on
BOM requests. End-to-end on-device testing in Phase 3 confirms it works against
the live endpoint; if the UA turns out to be stripped on-device, the BOM path
dies and we revisit the data source.

### Registration and seed

- `providers/index.js`: add `bom: require('./bom')` to `REGISTRY`.
- `index.js`: add `'bom'` to `CATALOG_PROVIDERS`.
- `stations.js`: add a few BOM seed stations (e.g. Sydney, Fort Denison) in the
  seed shape, extended with `tz` and `region`, for cold-start offline fallback.

Geolocation, nearest-station selection, union cache, 30-day TTL, blob packing,
and the C app are untouched. A BOM station competes by haversine distance like
any other; its `provider: 'bom'` tag routes the fetch.

## Data flow

1. Cold start: fetch all three catalogs (`dfo`, `noaa`, `bom`) in parallel,
   merge, select nearest to device location.
2. Warm start: select instantly from union cache; background-refresh stale
   slices per provider on the 30-day TTL.
3. Selected BOM station → `bom.hiloUrl` → text fetch with browser UA →
   `bom.parseHilo` → normalized points → blob → watch.
4. BOM fetch failure isolates: the stale BOM slice and last good predictions
   stay; NOAA/DFO unaffected.

## Error handling

- `parseCatalog` / `parseHilo` return `[]` on any bad input, never throw —
  matching NOAA/DFO. Empty points → caller keeps the cached prediction.
- Catalog fetch failure for BOM keeps the old BOM slice (existing per-provider
  isolation).
- "Access Denied" (missing/blocked UA) surfaces as an empty parse → cache held.
  Phase 3 end-to-end testing catches this before it ships.

## Testing (TDD, Node native test runner)

New `test/providers-bom.test.js`, mirroring `providers-noaa.test.js`:

- `catalogUrl` returns the catalog URL.
- `parseCatalog` maps a GeoJSON fixture → records with `tz`/`region`; keeps
  `AVAIL_FLAG === 'Y'`, drops others; returns `[]` on null/garbage.
- `hiloUrl` builds the table URL with `aac`, `date` (DD-MM-YYYY), `days`,
  `region`, `tz` from a station fixture; correct day-span for an 8-day window.
- `parseHilo` maps an HTML fixture (saved from a real BOM response) →
  `{ epoch, heightCm, kind }`; high→1, low→2; heights metres→cm; `[]` on empty
  HTML.
- Registry: `forStation({ provider: 'bom' })` returns the BOM adapter.

Extend `catalog.test.js`: `tz`/`region` survive `normalizeCatalogRecord` and
`unionStations`. Extend the fetch-layer test: `responseFormat: 'text'` hands raw
string; default `'json'` parses.

Fixtures: a trimmed `tide_prediction_sites.json` slice and a real
`getTidesTable.php` HTML capture, checked into `test/fixtures/`.

## Phases

- **Phase 1 — BOM adapter.** `bom.js` four functions, TDD against fixtures.
- **Phase 2 — Plumbing.** `responseFormat` text branch; `tz`/`region` through
  catalog cache; register `bom`; seed stations.
- **Phase 3 — End to end.** Geo-override emulator to an Australian location
  (per the screenshot geo-override note), confirm nearest BOM station, curve,
  and tide stepping. Full test suite green.

## Out of scope

- Tidal streams and tide offsets (separate BOM files).
- User-facing provider override (selection stays automatic by geography).
- Replacing NOAA/DFO.
