# Pebble Tides

A Pebble watchapp that shows a day's predicted tides — exact high/low times and a curve — for the user's nearest tide station. Stations come from two Providers: the Canadian DFO IWLS API and the US NOAA CO-OPS API.

## Language

**Provider**:
A tide-prediction data source the app can pull from. Two exist: **DFO** (Canada, IWLS) and **NOAA** (US, CO-OPS). Every Station belongs to exactly one Provider, which determines its `id` namespace, the endpoint used to fetch its predictions, and the response shape that must be normalised before use.

**Station**:
A tide-prediction location with a fixed latitude/longitude, belonging to one Provider, identified by an `id` (used in that Provider's API calls) and shown to the user by its `officialName`. The app picks the one nearest the user's current position, across both Providers.
_Avoid_: Site, location, port.

**Nearest Station**:
The single **Usable Station** with the smallest great-circle distance to the user's current position. The app tracks tides for exactly one Station at a time — the Nearest Station.

**Usable Station**:
A Station the app is willing to fetch hilo predictions for. The criteria are Provider-specific: a **DFO** Station is Usable when `operating: true` **and** its `timeSeries` advertises the `wlp-hilo` product; a **NOAA** Station is Usable when it appears in the `type=tidepredictions` catalog (both reference and subordinate stations qualify — subordinate stations still return valid predictions). Station selection considers only Usable Stations; others are never fetched.

**Station List**:
The set of Usable Stations the app selects from. Loaded **dynamically** by fetching each Provider's full catalog (DFO IWLS, NOAA MDAPI), filtering to Usable Stations, and merging into one Provider-tagged list. The merged list is cached on the phone and refreshed on a slow cadence (catalogs change rarely). A small bundled snapshot is the offline / first-run fallback. (Supersedes the original hand-trimmed BC-only subset; coverage is now provider-defined, not hand-curated.)

**Tide Prediction**:
A modelled future water level, as opposed to an observed measurement. This app uses predictions only.
_Avoid_: Observation, reading, measurement (those are the observed series, which this app does not use).

**Extremum** (plural **Extrema**):
A turning point in the tide curve — a local maximum or minimum. Sourced from the API's high/low series. Every High Tide and Low Tide is an Extremum.
_Avoid_: Peak, event.

**High Tide** / **Low Tide**:
An Extremum that is a local maximum (High) or local minimum (Low). The app labels these with exact time and height. A single day normally has two of each.

**Diurnal Inequality**:
The PNW pattern where a day's two High Tides (and two Low Tides) differ in height. The two Highs are distinct Extrema, not a measurement artifact.

**Double High** / **Double Low**:
A genuine reversal where the water rises, dips slightly, then rises again (or the mirror for lows) — three Extrema in a row. Distinct from a **Stand**.

**Stand** (or **Shoulder**):
A spot where the curve flattens but never reverses direction — no local max/min, so it is *not* an Extremum and does not appear in the high/low series. Visible only in the continuous curve.

**Mid Tide**:
The moment the water level crosses the midpoint between an adjacent High and Low. Derived, not an Extremum. Shown as secondary information when screen space allows.

**Tide Curve**:
The continuous water-level-over-time line drawn on screen for the visible window, generated as a cosine between consecutive Extrema (see docs/adr/0002). The Extrema are marked on top of it. (Originally built from hourly predictions per ADR 0001; superseded.)

**Focused Tide**:
The single Extremum the screen is currently centered on. UP steps to the previous Extremum, DOWN to the next; the window re-centers (with animation) so the Focused Tide sits in the middle of the screen. Its exact time, height, and countdown are shown as the headline. The default Focused Tide on launch is the next upcoming Extremum.

**Day**:
A calendar day in the Station's local time, used as a coarse navigation jump (long-press UP/DOWN moves ±1 Day ≈ 4 Extrema) and as the cache horizon ("the week" = 7 Days). Not the primary navigation unit — the Focused Tide is.

**Now Jump**:
The SELECT action that returns the Focused Tide to the next upcoming Extremum from wherever the user has paged to.

## Flagged ambiguities

**"Swipe"** — the original request said swipe left/right to change Day. Pebble has no touchscreen; navigation is the physical UP/DOWN buttons, and the unit stepped is the Focused Tide (single Extremum), not the Day. "Swipe" is not used.

**"The week"** — means the next 7 Days of predictions cached on the watch, refreshed once per day. Not a calendar week (Mon–Sun).

## Example dialogue

> **Dev:** When you say "show the high tide," you mean the highest water level that Day?
> **Expert:** The *higher* of the two High Tides, yes — but I still want both Highs marked. They're different heights; that's the Diurnal Inequality.
> **Dev:** And if the curve has a Double High — rises, dips, rises again?
> **Expert:** Three Extrema. Mark all three. But a Stand, where it just flattens without dipping — that's not an Extremum, so it only shows up in the Tide Curve, not as a labelled point.
> **Dev:** Mid Tide?
> **Expert:** Secondary. Only if there's room. It's the crossing halfway between a High and the next Low.
