# Pin a region (phone-side multi-station offline cache)

Status: accepted (supersedes ADR 0004)

## Decision

A pin is now a **region**, not a single Station. The user types a place and a
radius (e.g. "Desolation Sound", 150 km); PKJS geocodes the place to a center,
selects the Usable Stations within the radius nearest-first up to a hard cap, and
downloads a 45-Day blob for each. Every blob is cached in phone `localStorage`
under its own key — `tideBlob:<stationId>` holding `{ date, version, b64 }`, the
packed binary base64-encoded — and the region record (`center`, `radiusKm`,
`cap`, the `stations` list nearest-first, `fetchedAt`, `rangeDays`, `truncated`)
is written alongside.

On launch the phone takes a GPS fix, picks the nearest Station in
`region.stations`, reads its `tideBlob`, and sends that one blob to the watch
with **zero network**. Move to a new spot inside (or near) the region, reopen the
app, and the now-nearest cached Station is served the same way. When the launch is
online and the window has aged, the phone re-downloads the region in the
background to extend it; offline launches always serve the cache.

The watch is **unchanged**. It still holds exactly one Station's blob at a time;
the blob format and all watch C code carry over from ADR 0005. The smallest
radius caches just the nearest Station, so the shipped single-station pin
(v1.0.4) is the bottom of this range rather than a separate mode.

## Context

The shipped pin (ADR 0004) downloads one Station for a place the user is not at
yet. Boating breaks that: a user cruising an area with no signal needs the
nearest Station to wherever they currently are, and that Station changes as they
move. One pinned Station cannot follow them.

The obvious fix — cache every Station so any position is covered — does not fit.
We measured the catalogs:

| Provider | Stations |
| --- | --- |
| NOAA (US) | 3,450 |
| DFO (Canada) | 1,570 |
| BOM (AU/Pacific) | 737 |
| **Total** | **~5,750** |

A 45-Day blob is ~3 KB binary (`MAX_BLOB_BYTES` 3072), ~4.5 KB as base64 in
`localStorage`. Caching all ~5,750 is ~26 MB of strings, about 5× over the ~5 MB
Web Storage quota the Pebble phone app provides. Storage is not even the first
wall: each Station is a separate hilo HTTP request, so ~5,750 serial requests at
~0.5 s each is 45+ minutes and hammers the providers hard enough to risk an IP
block. A bounded region fixes both. A coastal area within ~150 km is ~100–400
Stations (NOAA is dense, with subordinate stations every few km), which is
~1–2 MB and a ~3–4 minute one-time download on wifi.

The watch cannot hold the cache: its persistent storage is ~4 KB, sized for one
45-Day blob (ADR 0005). Hundreds of Stations have to live on the phone, where
`localStorage` has room and the launch path already runs the geo selection.

## Considered options

- **Cache the global catalog on the phone.** Any position covered with no region
  to configure. Rejected on the numbers above — ~26 MB over a ~5 MB quota and a
  45-minute scrape that risks rate-limiting.
- **Cache the region on the watch.** Keep selection on the watch, push every
  region blob to persist. Rejected: the ~4 KB persist budget fits one Station,
  not hundreds.
- **Pin a bounded region, cache its Stations on the phone (chosen).** Geocoded
  center plus radius plus a hard Station cap; the phone caches each region
  Station's blob and serves the nearest on launch. Covers movement across the
  area offline, stays inside the storage quota, and bounds the download. Costs a
  region record, a per-Station blob cache, and a one-time multi-minute download
  when pinning.

## Consequences

- The `pin` record (one Station) becomes a `region` record (center, radius, cap,
  Station list, window metadata). Selection on launch reads `region.stations`
  rather than a single pinned id.
- Per-Station blob keys mean a Station can be written, read, or evicted
  independently, and an interrupted download leaves completed Stations intact;
  the next online launch's background refresh fills the gaps.
- Pinning needs connectivity — it is the download-ahead moment. Offline at pin
  time writes the region record with a connect-to-internet error and an empty
  set.
- Predictions are static for the dates they cover, so a cached region stays
  correct until its 45-Day window runs out. Refresh is a window-age check on
  online launches, not a per-day refetch (see ADR 0007 for the budget that bounds
  what gets cached).
- Moving outside the region falls back to the nearest cached Station, which may be
  distant; the existing far-distance warning (`FAR_WARNING_KM`) applies unchanged.
- The watch stays Provider- and feature-agnostic. The entire change is phone-side
  PKJS; the blob format and watch C code are untouched.
