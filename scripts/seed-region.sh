#!/usr/bin/env bash
# Seed a pinned region straight into the emulator's localStorage so you can test
# the offline region feature without the config webview (which doesn't round-trip
# in the emulator -- its Save targets pebblejs://close, only the real phone app
# handles that). Builds the region offline (geocode + select + download), writes
# it into pypkjs's dbm.dumb store, then launches the app, which serves the
# nearest cached station from that seed -- no network.
#
# Usage: scripts/seed-region.sh "<place>" [radiusKm] [rangeDays] [platform]
#   scripts/seed-region.sh "Vancouver BC" 25 45 gabbro
#
# To then test "moving", force GPS to a point in the region and relaunch:
#   scripts/emulate.sh "49.30 -123.10"   (note: emulate.sh wipes; re-seed after)
set -euo pipefail
cd "$(dirname "$0")/.."

PLACE="${1:-}"; [ -n "$PLACE" ] || { echo 'usage: scripts/seed-region.sh "<place>" [radiusKm] [rangeDays] [platform]' >&2; exit 2; }
RADIUS="${2:-25}"
DAYS="${3:-45}"
PLAT="${4:-gabbro}"
CAP=400

SEED="$(mktemp -t region-seed).json"
trap 'rm -f "$SEED"' EXIT

echo "Building region cache for \"$PLACE\" ($RADIUS km, $DAYS days) ..."
node scripts/seed-region.js "$PLACE" "$RADIUS" "$DAYS" "$CAP" > "$SEED"

echo "Building + installing the app once (creates the emulator store) ..."
pebble build >/dev/null
pebble install --emulator "$PLAT" >/dev/null
sleep 2

echo "Stopping the emulator so its localStorage is flushed ..."
pebble kill >/dev/null 2>&1 || true
pkill -9 -f qemu >/dev/null 2>&1 || true
sleep 2

echo "Seeding the region into localStorage ..."
python3 scripts/seed-region.py "$PLAT" < "$SEED"

echo "Relaunching the app (it should serve the nearest cached station, no network) ..."
pebble install --emulator "$PLAT" >/dev/null
echo
echo "Done. The watch should now show a station from \"$PLACE\". Watch logs with:"
echo "  pebble logs --emulator $PLAT      # look for 'Region pinned' + 'serving ... from cache'"
