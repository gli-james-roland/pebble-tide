#!/usr/bin/env bash
# Build and publish Pebble Tides to the repebble appstore in one step.
#
# Prerequisites:
#   1. pebble login            (or export PEBBLE_FIREBASE_ID_TOKEN=... for CI)
#   2. set CATEGORY below to a valid appstore category key
#
# Usage: scripts/publish.sh [extra pebble-publish flags]
#   e.g. scripts/publish.sh --is-published     # make the release visible now
set -euo pipefail
cd "$(dirname "$0")/.."

CATEGORY="${PEBBLE_CATEGORY:-Tools}"   # adjust to a valid appstore category key
NAME="Pebble Tides"
VERSION="$(python3 -c "import json;print(json.load(open('package.json'))['version'])")"

echo "Building $NAME $VERSION ..."
pebble build

# pebble publish expects screenshot filenames prefixed by platform name.
SHOTS=()
if compgen -G "screenshots/*.png" >/dev/null; then
  STAGE="$(mktemp -d)"
  for f in screenshots/*.png; do
    plat="$(basename "$f" .png)"
    cp "$f" "$STAGE/${plat}_screenshot.png"
    SHOTS+=("$STAGE/${plat}_screenshot.png")
  done
fi

echo "Publishing $NAME $VERSION ..."
pebble publish \
  --non-interactive \
  --no-gif-all-platforms \
  --name "$NAME" \
  --version "$VERSION" \
  --category "$CATEGORY" \
  --description "$(cat store/description.txt)" \
  --release-notes "${RELEASE_NOTES:-Version $VERSION}" \
  --icon-small resources/images/icon_small_48.png \
  --icon-large resources/images/appstore_icon.png \
  ${SHOTS:+--screenshots "${SHOTS[@]}"} \
  "$@"
echo "Done."
