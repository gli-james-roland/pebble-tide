# Pin a region for offline use (phone-side multi-station cache)

Date: 2026-06-13
Status: Draft — awaiting review

## Goal

Let a user pre-download tide predictions for a whole area, not a single station,
so they can move around that area with no internet and the watch still shows the
nearest station's tides.

The driving case is boating. Before a trip, on wifi, the user pins a cruising
area ("Desolation Sound", 150 km). The phone downloads 45 days of predictions
for every usable station in that area and caches them. Out on the water with no
signal, each time they open the watchapp the phone's GPS picks the nearest cached
station and sends it to the watch, with no network call.

This **replaces** the shipped single-station pin (v1.0.4, ADR 0004/0005). A pin
is now always a region; the smallest radius caches just the nearest station, so
the old behavior is the bottom of the new range.

## Why a region, and why it must be bounded

We measured the alternative — cache everything — and it does not fit.

| Provider | Stations |
| --- | --- |
| NOAA (US) | 3,450 |
| DFO (Canada) | 1,570 |
| BOM (AU/Pacific) | 737 |
| **Total** | **~5,750** |

A 45-day blob is ~3 KB binary (`MAX_BLOB_BYTES` 3072); base64 in localStorage it
is ~4.5 KB. Caching all stations is ~26 MB of localStorage strings — about 5×
over the ~5 MB Web Storage quota the Pebble phone app provides.

Storage is not even the first wall. Each station is a **separate** hilo HTTP
request. ~5,750 requests serially at ~0.5 s each is ~45+ minutes and hammers the
providers hard enough to risk rate-limiting or an IP block. A bounded region
fixes both: a coastal area within ~150 km is ~100–400 stations (NOAA is dense,
with subordinate stations every few km), which is ~1–2 MB and a ~3–4 minute
one-time download.

A radius alone is not enough — a dense area could still pull 1,000+ stations. The
region carries a **hard cap** (station count and byte budget), and downloads the
nearest stations up to that cap.

## Data model

The `pin` record (single station) is replaced by a `region` record in
localStorage:

```js
region = {
  mode: 'region',
  place: "Desolation Sound",     // what the user typed
  center: { lat, lon },          // geocoded from place
  radiusKm: 150,
  cap: 400,                      // max stations cached
  stations: [                    // the cached set, nearest-first
    { id, officialName, latitude, longitude, provider, tz, region },
    ...
  ],
  fetchedAt: "2026-06-13",       // window anchor; drives staleness
  rangeDays: 45,
  truncated: false,              // true if cap/budget clipped the set
  error: null
}
```

Each station's packed blob is cached under its own key, so a station can be
written, read, or evicted independently and an interrupted download leaves
completed stations intact:

```
tideBlob:<stationId>  ->  { date: "2026-06-13", version: BLOB_VERSION, b64: "<base64>" }
```

We do **not** iterate `localStorage` to find these keys. pypkjs makes
`localStorage.key()` O(n) and its ordering unstable (known footgun in this repo);
the authoritative id list lives in `region.stations`, and eviction diffs against
it.

## Architecture: where the blobs live

The phone holds the region; the watch still holds **one** station at a time.

- **Chosen — phone localStorage.** The phone caches every region blob. On launch
  it selects the nearest cached station and sends that single blob to the watch.
  The watch C code and blob format are unchanged.
- **Rejected — watch persist.** The watch's persistent storage is ~4 KB, sized
  for one 45-day blob (ADR 0005). It cannot hold hundreds of stations.

## Flows

### A. Pin a region (config save — requires internet)

1. Geocode `place` → `center` (existing `geocode.js`, OSM Nominatim).
2. Ensure catalog slices covering the region are cached; fetch any missing
   (existing `catalog.js` / `fetchCatalogSlice`).
3. Select usable stations within `radiusKm` of `center`, nearest-first, stopping
   at `cap` or the byte budget, whichever comes first. Set `truncated`
   accordingly.
4. Download hilo for each selected station, pack to a blob, write
   `tideBlob:<id>`. Report progress to the config page ("37 / 400").
5. Evict `tideBlob:*` for any id no longer in the set (previous region's
   leftovers).
6. Write the `region` record with `fetchedAt = today`.

Offline at this step → no download possible → write the record with
`error: "Connect to the internet to download this region"` and an empty set.

### B. Launch (`ready`)

- **Region pinned, GPS fix:** pick the nearest station in `region.stations`, read
  its `tideBlob`, send to the watch. **Zero network.** If online and the window
  has aged past the threshold, start a background re-download of the region (does
  not block this display).
- **Region pinned, no GPS:** fall back to the last-served station, else the
  station nearest `region.center`.
- **No region (Auto):** unchanged current behavior (online nearest-station, daily
  refresh).

### C. Moving offline

Arrive at a new spot, open the app, GPS returns new coordinates, the phone
selects the now-nearest cached station and serves it. Works anywhere inside (or
near) the region. Outside it, the nearest cached station may be distant — the
existing far-distance warning (`FAR_WARNING_KM`) applies unchanged.

### D. Refresh

Predictions are static for the dates they cover, so a cached region stays correct
until its 45-day window runs out. On launch, if online and `fetchedAt` is older
than the staleness threshold (window has ~30 days or less left, i.e. data older
than ~15 days), re-download the whole region in the background to extend it.
Offline launches never refresh; they serve the cache. No watch-side staleness
indicator in this version.

## Storage budget

Assume ~5 MB localStorage, conservatively. Reserve for the catalog cache
(~0.5 MB), config, and headroom. Region blob budget ≈ **2.5 MB**.

- Default `cap = 400` (~1.8 MB at ~4.5 KB/blob). Hard max 500.
- Enforce **both** the station count and a running byte total during selection
  and download. Hitting either stops the download and sets `truncated = true`
  with a note ("cached nearest 400 of 920 stations").
- A `localStorage.setItem` quota failure mid-download stops the download and
  marks the region truncated rather than throwing.

## Module changes

- `pin.js` → **`region.js`** — new record shape, `parseResponse` (place,
  radiusKm, cap), read/write/clear.
- **new `regionselect.js`** — given center/radius/cap and the cached catalog
  union, return usable stations nearest-first within radius, capped. Reuses the
  existing haversine and the `selectStation` selection rules.
- **new `blobcache.js`** — `get(id)`, `set(id, blob)`, `clear(id)`, byte
  accounting, and orphan eviction by id-set diff.
- `index.js` —
  - `webviewclosed` region branch: geocode → select set → sequential download
    loop with progress → write blobs + region record → evict orphans.
  - `ready` region branch: `locate()` → nearest in `region.stations` → load
    cached blob → send to watch; background refresh when online and aged.
  - new `sendCachedOrFetch()` — serve from cache vs. today's fetch-always path.
- `config.js` — config page gains a radius control and a live
  station-count / download-progress readout; `pageUrl` passes the region.
- `refresh.js` — add a region staleness check (window-age threshold) alongside
  the existing per-day logic.
- providers / `blob.js` / **watch C code** — **unchanged.**

## Download mechanics

Sequential, one request at a time, to stay polite to the providers. ~400
stations × ~0.5 s ≈ ~3–4 minutes, one-time, on wifi, with a progress readout. An
interrupted download leaves completed `tideBlob` keys in place; the next online
launch's background refresh fills the missing stations.

## Edge cases

- **Empty region** (radius too small, or inland) → `error: "No stations within
  <radius> of <place>"`.
- **Offline at pin time** → record written with a connect-to-internet error,
  empty set.
- **Interrupted download** → per-station storage means completed stations
  survive; background refresh completes the rest when online.
- **GPS denied/unavailable offline** → last-served station, else center-nearest.
- **Quota write failure mid-download** → stop, mark truncated.
- **Moved outside region** → existing far-distance warning.

## Testing

Existing `node --test` suite with injected-localStorage fakes and mock providers.

- `region.parseResponse` and record read/write/clear/shape.
- `regionselect`: radius filter, nearest-first ordering, count cap, byte budget,
  truncation flag.
- `blobcache`: set/get/clear, byte accounting, orphan eviction by id diff.
- `refresh`: region staleness thresholds (fresh vs. aged), independent of the
  per-day path.
- `index` flows, with mocked geolocation and fetch:
  - pin a region downloads and caches the selected set;
  - launch serves the nearest cached station;
  - **offline launch serves the cache with zero fetch calls** (assert no network
    call);
  - background refresh fires only when online and aged.

## Out of scope

- Watch-side staleness indicator (deferred; auto-refresh covers the common case).
- Multiple saved regions (one region at a time).
- On-device tide computation from harmonic constituents (we cache provider hilo).

## Follow-up ADRs

This supersedes ADR 0004 (single-station pin) and revises ADR 0005's "Pinned
Mode" framing. Record both as new ADRs once the design is approved:

- ADR 0006 — Pin a region (phone-side multi-station offline cache), supersedes
  0004.
- ADR 0007 — Phone localStorage budget and the region cap/eviction policy.
