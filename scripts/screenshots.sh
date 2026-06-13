#!/usr/bin/env bash
# Capture fresh store art from the emulators into screenshots/. For each watch
# platform this produces FOUR files that scripts/publish.sh then uploads:
#
#   screenshots/<plat>.png            static shot at the default (BC / DFO) location
#   screenshots/<plat>-seattle.png    static shot forced to Seattle (NOAA)
#   screenshots/<plat>-sydney.png     static shot forced to Sydney (BOM)
#   screenshots/<plat>-animated.gif   the tide focus rolling forward 3 tides
#
# Refresh-the-listing flow:  make screenshots && make publish
#
# Seattle and Sydney are forced by patching pypkjs's geolocation.py to hand back
# fixed coordinates (the emulator has no set-location command and the app calls
# navigator.geolocation). The patch is always restored on exit, and between the
# two forced sections so each starts from a clean file.
#
# Overrides:
#   PEBBLE_SHOT_PLATFORMS    platforms to capture (default: gabbro chalk emery diorite)
#   PEBBLE_SHOT_SETTLE       seconds to let the BC/DFO path render (default: 18)
#   PEBBLE_SHOT_SETTLE_NOAA  seconds for the slower NOAA cold start (default: 40)
#   PEBBLE_SHOT_SETTLE_BOM   seconds for the slower BOM cold start (default: 40)
#   PEBBLE_SHOT_PAN_MS       slowed curve-pan length (ms) for GIF capture (default: 4000)
#   PEBBLE_SHOT_GIF_DELAY    GIF delay per moving frame, centiseconds (default: 6)
#   PEBBLE_SHOT_GIF_HOLD     GIF hold on each settled tide, centiseconds (default: 120)
set -euo pipefail
cd "$(dirname "$0")/.."

PLATFORMS="${PEBBLE_SHOT_PLATFORMS:-gabbro chalk emery diorite}"
SETTLE="${PEBBLE_SHOT_SETTLE:-18}"
SETTLE_NOAA="${PEBBLE_SHOT_SETTLE_NOAA:-40}"
SETTLE_BOM="${PEBBLE_SHOT_SETTLE_BOM:-40}"
PAN_MS="${PEBBLE_SHOT_PAN_MS:-4000}"     # slowed curve-pan length (ms) for capture
GIF_DELAY="${PEBBLE_SHOT_GIF_DELAY:-6}"  # GIF delay per moving frame (centiseconds)
GIF_HOLD="${PEBBLE_SHOT_GIF_HOLD:-120}"  # GIF hold on each settled tide (centiseconds)
GIF_STEPS=4                            # tides to roll forward in the animation
SEATTLE_LAT=47.602638
SEATTLE_LON=-122.339432              # NOAA station 9447130
SYDNEY_LAT=-33.8543
SYDNEY_LON=151.2253                  # BOM station NSW_TP007 (Fort Denison)

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
# Usage: patch_geo NAME LAT LON. Always restore_geo before patching again so
# each call starts from a clean geolocation.py.
patch_geo() {
  local name="$1" lat="$2" lon="$3"
  cp "$GEO_PY" "$GEO_PY.bak"
  LAT="$lat" LON="$lon" "$PEBBLE_PY" - "$GEO_PY" <<'PY'
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
  echo "Patched geolocation.py -> $name ($lat, $lon)"
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

# Slow the curve-pan (see wscript) so the GIF capture below can sample it;
# static shots are unaffected because the pan only runs on a button press.
PEBBLE_TIDES_PAN_MS="$PAN_MS" pebble build
mkdir -p screenshots

# --- Default location (BC / DFO): static shot + rolling-tides GIF ----------
# The GIF captures the curve-pan animation itself, not just the settled tides.
# The pan was slowed to PAN_MS at build time; here we fire screenshots as fast
# as the emulator allows across each pan window, then replay them quickly.
pan_secs=$(( (PAN_MS + 999) / 1000 ))
for plat in $PLATFORMS; do
  echo "Capturing $plat (BC + animation) ..."
  launch_fresh "$plat" "$SETTLE"
  shot "$plat" "screenshots/${plat}.png"
  echo "  -> screenshots/${plat}.png"

  # Frame 0 is the settled starting tide. For each step, press DOWN and grab
  # frames across the whole pan window (the tail frames land on the next
  # settled tide). Indices that land settled get a longer hold in the GIF.
  frames="$(mktemp -d)"
  idx=0
  cp "screenshots/${plat}.png" "$(printf '%s/f%04d.png' "$frames" "$idx")"
  settled="$idx"
  for _ in $(seq 1 "$GIF_STEPS"); do
    pebble emu-button --emulator "$plat" click down >/dev/null 2>&1
    deadline=$(( SECONDS + pan_secs + 1 ))
    while [ "$SECONDS" -lt "$deadline" ]; do
      idx=$((idx + 1))
      shot "$plat" "$(printf '%s/f%04d.png' "$frames" "$idx")"
    done
    settled="$settled $idx"
  done

  # Short delay on moving frames, a longer hold on each settled tide.
  args=()
  for f in "$frames"/f*.png; do
    n=$(( 10#$(basename "$f" .png | tr -dc '0-9') ))
    case " $settled " in
      *" $n "*) args+=(-delay "$GIF_HOLD" "$f") ;;
      *)        args+=(-delay "$GIF_DELAY" "$f") ;;
    esac
  done
  magick -loop 0 "${args[@]}" -layers optimize "screenshots/${plat}-animated.gif"
  rm -rf "$frames"
  echo "  -> screenshots/${plat}-animated.gif (now + $GIF_STEPS tides, pan captured)"
done

# --- Seattle (NOAA): static shot, geolocation forced ------------------------
patch_geo "Seattle" "$SEATTLE_LAT" "$SEATTLE_LON"
for plat in $PLATFORMS; do
  echo "Capturing $plat (Seattle) ..."
  launch_fresh "$plat" "$SETTLE_NOAA"
  shot "$plat" "screenshots/${plat}-seattle.png"
  echo "  -> screenshots/${plat}-seattle.png"
done
restore_geo

# --- Sydney (BOM): static shot, geolocation forced --------------------------
patch_geo "Sydney" "$SYDNEY_LAT" "$SYDNEY_LON"
for plat in $PLATFORMS; do
  echo "Capturing $plat (Sydney) ..."
  launch_fresh "$plat" "$SETTLE_BOM"
  shot "$plat" "screenshots/${plat}-sydney.png"
  echo "  -> screenshots/${plat}-sydney.png"
done
restore_geo
trap - EXIT

pebble kill >/dev/null 2>&1 || true
echo "Done. Run 'make publish' to upload the refreshed screenshots to the listing."
