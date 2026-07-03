# Changelog

Release notes for Pebble Tides. The release scripts read these: `release.sh`
promotes `[Unreleased]` to the new version and posts it as the GitHub release
notes; `publish.sh` posts the matching version's section to the appstore.

Write the next release's notes as bullets under `## [Unreleased]`.

## [Unreleased]

## [1.0.8] - 2026-07-02
- Fixed a fresh install hanging on "Loading…" and the Settings gear staying dark. The first launch used a JavaScript feature (Promise) the watch runtime does not support, which crashed the phone-side code before it could fetch tides or open settings.

## [1.0.7] - 2026-07-02
- Fixed the phone Settings gear not appearing, so you can set units, clock, and mid-tide again.

## [1.0.6] - 2026-06-13
- United Kingdom, Ireland and Channel Islands tide coverage via the UK Hydrographic Office (EasyTide).

## [1.0.5] - 2026-06-13
- Pin a region instead of a single station: pick a place and a cache radius, and download up to 45 days of tides for every station in that area. Offline, the watch shows the nearest cached station and switches as you move; it refreshes in the background when you're online. Replaces the single-station pin.

## [1.0.4] - 2026-06-12
- Pin a station for a place you're travelling to and download up to 45 days of tides for offline use. Pick the place and a 7/15/30/45-day range from the phone; clear the pin to return to using your location.

## [1.0.3] - 2026-06-12
- Australia and the South Pacific tide coverage via the Bureau of Meteorology (BOM).
- Fixed a pan-animation warning ("animation.c ... does not exist") on tide stepping.

## [1.0.2] - 2026-06-09
- Added United States coverage via NOAA, picking the nearest station across providers.
- Expanded Canada (DFO) from the seeded BC subset to the full national station list, loaded dynamically with a per-provider cache.
- Fixed NOAA stations (e.g. Seattle) staying stuck on "Loading".
- Added `make release`/`make publish` automation and CI build + tests on every PR.
- Fixed appstore screenshots duplicating on each publish instead of replacing.

## [1.0.1] - 2026-06-08
- Mid-tide times and dots now default to off, reducing clutter.
- Tide pills clamp inside the plot area instead of overflowing.
- Fixed menu icon contrast and kept the curve gradient during a pan.

## [1.0.0] - 2026-06-07
- Initial release: daily tide graph with high/low times and heights, current level with a rising/falling indicator, and mid-tide times.
- Sunrise and sunset night shading.
- Step through tides with the buttons; long-press to jump a day, Select to jump to now.
- Feet or metres and a 12 or 24 hour clock, set from the phone.
- Caches a week of predictions and refreshes once a day; works with the phone out of range.
- Coverage: the Pacific Northwest (British Columbia) via Fisheries and Oceans Canada (DFO).
