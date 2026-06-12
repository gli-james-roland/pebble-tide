#!/usr/bin/env bash
# Launch the emulator with a forced geolocation, to exercise each tide provider
# without being there. The emulator has no set-location command and the app reads
# navigator.geolocation, so we patch pypkjs's geolocation.py to hand back fixed
# coordinates (same trick as screenshots.sh). The patch is always restored on exit.
#
# Usage: scripts/emulate.sh <location> [platform]
#   location: australia | seattle | vancouver | "<LAT> <LON>"
#   platform: gabbro (default) or any Pebble platform
#
# Watch the logs for 'bom|noaa|dfo catalog cached (N stations)', the nearest
# station, and a blob sent. For BOM, an 'Access Denied' / HTTP 403 means the
# on-device User-Agent was stripped. Ctrl-C stops the log stream; geo restores.
set -euo pipefail

usage() {
  echo "usage: scripts/emulate.sh <australia|seattle|vancouver|LAT LON> [platform]" >&2
  exit 2
}

LOC="${1:-}"; [ -n "$LOC" ] || usage
case "$LOC" in
  australia) LAT=-33.8543; LON=151.2253;  NAME="Sydney, AU (BOM)";       PLAT="${2:-gabbro}" ;;
  seattle)   LAT=47.6026;  LON=-122.3394; NAME="Seattle, US (NOAA)";     PLAT="${2:-gabbro}" ;;
  vancouver) LAT=49.2863;  LON=-123.0997; NAME="Vancouver, CA (DFO)";    PLAT="${2:-gabbro}" ;;
  *) LAT="$1"; LON="${2:-}"; [ -n "$LON" ] || usage; NAME="($LAT, $LON)"; PLAT="${3:-gabbro}" ;;
esac

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

cp "$GEO_PY" "$GEO_PY.bak"
LAT="$LAT" LON="$LON" "$PEBBLE_PY" - "$GEO_PY" <<'PY'
import os, sys
path = sys.argv[1]
src = open(path).read()
marker = "    def _get_position(self, success, failure):\n"
if marker not in src:
    sys.exit("could not find _get_position in %s" % path)
# Coordinates(long, lat, accuracy) -- longitude first.
override = (
    "        # PEBBLE_TIDES_GEO_OVERRIDE\n"
    "        self.runtime.enqueue(success, Position(self.runtime, Coordinates("
    "self.runtime, %s, %s, 1000), round(time.time() * 1000))); return\n"
    % (os.environ["LON"], os.environ["LAT"])
)
open(path, "w").write(src.replace(marker, marker + override, 1))
PY
echo "Patched geolocation.py -> $NAME ($LAT, $LON)"

pebble build >/dev/null
pebble kill  >/dev/null 2>&1 || true
sleep 2
pebble wipe  >/dev/null 2>&1 || true
pebble install --emulator "$PLAT"
echo "Installed on $PLAT, forced to $NAME. Streaming logs -- Ctrl-C to stop (geo restores)."
pebble logs --emulator "$PLAT"
