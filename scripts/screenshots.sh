#!/usr/bin/env bash
# Capture fresh store screenshots from the emulators into screenshots/.
# These are the images `scripts/publish.sh` uploads to the appstore listing,
# so the flow to refresh the listing art is:  make screenshots && make publish
#
# Override the platform set with PEBBLE_SHOT_PLATFORMS (space separated).
set -euo pipefail
cd "$(dirname "$0")/.."

PLATFORMS="${PEBBLE_SHOT_PLATFORMS:-gabbro chalk emery diorite}"
SETTLE="${PEBBLE_SHOT_SETTLE:-16}"   # seconds to let the phone fetch + watch render

pebble build
mkdir -p screenshots

for plat in $PLATFORMS; do
  echo "Capturing $plat ..."
  pebble kill >/dev/null 2>&1 || true
  pkill -9 -f qemu >/dev/null 2>&1 || true
  sleep 2
  pebble wipe >/dev/null 2>&1 || true   # fresh cache so the graph repopulates
  pebble install --emulator "$plat" >/dev/null
  sleep "$SETTLE"
  pebble screenshot --emulator "$plat"
  mv "$(ls -t pebble_screenshot_*.png | head -1)" "screenshots/${plat}.png"
  echo "  -> screenshots/${plat}.png"
done
pebble kill >/dev/null 2>&1 || true
echo "Done. Run 'make publish' to upload the refreshed screenshots to the listing."
