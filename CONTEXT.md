# Pebble Tides

A Pebble watchapp that shows a day's predicted tides — exact high/low times and a curve — for the user's nearest Canadian tide station. Data comes from the Canadian DFO IWLS prediction API.

## Language

**Station**:
A DFO tide-prediction location with a fixed latitude/longitude, identified by an `id` (used in API calls) and shown to the user by its `officialName`. The app picks the one nearest the user's current position.
_Avoid_: Site, location, port.

**Nearest Station**:
The single **Usable Station** with the smallest great-circle distance to the user's current position. The app tracks tides for exactly one Station at a time — the Nearest Station.

**Usable Station**:
A Station with `operating: true`. `operating` comes from the DFO API itself. Station selection considers only Usable Stations; `operating: false` stations are never fetched.

**Station List**:
The set of Stations in [src/resources/tide_stations.json](src/resources/tide_stations.json) (moving into pkjs). It is a **hand-trimmed subset** of the full DFO station set — the maintainer manually removed stations the app should never consider. The API exposes more stations than appear here; absence from the Station List is intentional, not an oversight.

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
The continuous water-level-over-time line drawn on screen for one day, built from hourly Tide Predictions. The Extrema are marked on top of it.

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
