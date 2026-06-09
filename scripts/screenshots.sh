#!/usr/bin/env bash
# Capture fresh store art from the emulators into screenshots/. For each watch
# platform this produces THREE files that scripts/publish.sh then uploads:
#
#   screenshots/<plat>.png            static shot at the default (BC / DFO) location
#   screenshots/<plat>-seattle.png    static shot forced to Seattle (NOAA)
#   screenshots/<plat>-animated.gif   the tide focus rolling forward 3 tides
#
# Refresh-the-listing flow:  make screenshots && make publish
#
# Seattle is forced by patching pypkjs's geolocation.py to hand back fixed
# coordinates (the emulator has no set-location command and the app calls
# navigator.geolocation). The patch is always restored on exit.
#
# Overrides:
#   PEBBLE_SHOT_PLATFORMS    platforms to capture (default: gabbro chalk emery diorite)
#   PEBBLE_SHOT_SETTLE       seconds to let the BC/DFO path render (default: 18)
#   PEBBLE_SHOT_SETTLE_NOAA  seconds for the slower NOAA cold start (default: 40)
#   PEBBLE_SHOT_STEP_SETTLE  seconds between tide steps for the GIF (default: 2)
set -euo pipefail
cd "$(dirname "$0")/.."

PLATFORMS="${PEBBLE_SHOT_PLATFORMS:-gabbro chalk emery diorite}"
SETTLE="${PEBBLE_SHOT_SETTLE:-18}"
SETTLE_NOAA="${PEBBLE_SHOT_SETTLE_NOAA:-40}"
STEP_SETTLE="${PEBBLE_SHOT_STEP_SETTLE:-2}"
GIF_STEPS=3                          # tides to roll forward in the animation
SEATTLE_LAT=47.602638
SEATTLE_LON=-122.339432              # NOAA station 9447130

command -v magick >/dev/null || { echo "error: ImageMagick 'magick' is required for the GIF" >&2; exit 1; }

# pypkjs ships inside the interpreter behind the `pebble` launcher.
PEBBLE_PY="$(sed -n '1s/^#!//p' "$(command -v pebble)")"
GEO_PY="$("$PEBBLE_PY" -c 'import pypkjs.javascript.navigator.geolocation as g; print(g.__file__)')"

restore_geo() {
  if [ -f "$GEO_PY.bak" ]; then
    mv -f "$GEO_PY.bak" "$GEO_PY"
    echo "Restored geolocation.py"
  fi
}
trap restore_geo EXIT

# Insert an early return into _get_position that hands back fixed coordinates.
patch_geo_seattle() {
  cp "$GEO_PY" "$GEO_PY.bak"
  LAT="$SEATTLE_LAT" LON="$SEATTLE_LON" "$PEBBLE_PY" - "$GEO_PY" <<'PY'
import os, sys
path = sys.argv[1]
src = open(path).read()
marker = "    def _get_position(self, success, failure):\n"
if marker not in src:
    sys.exit("could not find _get_position in %s" % path)
# Coordinates(long, lat, accuracy) -- note longitude first.
override = (
    "        # PEBBLE_TIDES_GEO_OVERRIDE\n"
    "        self.runtime.enqueue(success, Position(self.runtime, Coordinates("
    "self.runtime, %s, %s, 1000), round(time.time() * 1000))); return\n"
    % (os.environ["LON"], os.environ["LAT"])
)
open(path, "w").write(src.replace(marker, marker + override, 1))
PY
  echo "Patched geolocation.py -> Seattle ($SEATTLE_LAT, $SEATTLE_LON)"
}

# Kill any emulator, wipe its data, install fresh, and let it render.
launch_fresh() {
  local plat="$1" settle="$2"
  pebble kill >/dev/null 2>&1 || true
  pkill -9 -f qemu >/dev/null 2>&1 || true
  sleep 2
  pebble wipe >/dev/null 2>&1 || true
  pebble install --emulator "$plat" >/dev/null
  sleep "$settle"
}

# Grab a screenshot from the running emulator into $2 (no Preview pop-ups).
shot() {
  local plat="$1" out="$2"
  pebble screenshot --emulator "$plat" --no-open >/dev/null 2>&1
  mv -f "$(ls -t pebble_screenshot_*.png | head -1)" "$out"
}

pebble build
mkdir -p screenshots

# --- Default location (BC / DFO): static shot + rolling-tides GIF ----------
for plat in $PLATFORMS; do
  echo "Capturing $plat (BC + animation) ..."
  launch_fresh "$plat" "$SETTLE"
  shot "$plat" "screenshots/${plat}.png"
  echo "  -> screenshots/${plat}.png"

  # Reuse the running emulator: shoot now, then step forward one tide at a time.
  frames="$(mktemp -d)"
  cp "screenshots/${plat}.png" "$frames/frame0.png"
  for i in $(seq 1 "$GIF_STEPS"); do
    pebble emu-button --emulator "$plat" click down >/dev/null 2>&1
    sleep "$STEP_SETTLE"
    shot "$plat" "$frames/frame${i}.png"
  done
  magick -delay 120 -loop 0 "$frames"/frame*.png "screenshots/${plat}-animated.gif"
  rm -rf "$frames"
  echo "  -> screenshots/${plat}-animated.gif (now + $GIF_STEPS tides)"
done

# --- Seattle (NOAA): static shot, geolocation forced ------------------------
patch_geo_seattle
for plat in $PLATFORMS; do
  echo "Capturing $plat (Seattle) ..."
  launch_fresh "$plat" "$SETTLE_NOAA"
  shot "$plat" "screenshots/${plat}-seattle.png"
  echo "  -> screenshots/${plat}-seattle.png"
done
restore_geo
trap - EXIT

pebble kill >/dev/null 2>&1 || true
echo "Done. Run 'make publish' to upload the refreshed screenshots to the listing."
