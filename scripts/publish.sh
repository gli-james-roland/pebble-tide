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

CATEGORY="${PEBBLE_CATEGORY:-Tools & Utilities}"
NAME="Pebble Tides"
VERSION="$(python3 -c "import json;print(json.load(open('package.json'))['version'])")"

# Release notes: explicit RELEASE_NOTES override, else the version's CHANGELOG.md
# section (the same notes release.sh posts to the GitHub release). Fail fast
# rather than publishing a placeholder.
NOTES="${RELEASE_NOTES:-$(scripts/changelog.sh extract "$VERSION")}"
if [ -z "$NOTES" ]; then
  echo "error: no release notes for $VERSION in CHANGELOG.md (set RELEASE_NOTES to override)" >&2
  exit 1
fi

echo "Building $NAME $VERSION ..."
pebble build

# pebble publish infers each screenshot's platform from the filename: it takes
# the text before the first "_". Source files are <platform>.png and
# <platform>-<variant>.png (e.g. chalk.png, chalk-seattle.png), so stage them as
# <platform>_<variant>_screenshot.png to keep a valid platform prefix. A file
# whose platform isn't in the build is skipped with a warning rather than
# uploaded under a bogus platform name.
PLATFORMS="$(python3 -c "import json;print(' '.join(json.load(open('package.json'))['pebble']['targetPlatforms']))")"
SHOTS=()
if compgen -G "screenshots/*.png" >/dev/null || compgen -G "screenshots/*.gif" >/dev/null; then
  STAGE="$(mktemp -d)"
  for f in screenshots/*.png screenshots/*.gif; do
    [ -e "$f" ] || continue                # skip the literal glob if a type is absent
    ext="${f##*.}"                         # png or gif (pebble publish accepts both)
    base="$(basename "$f" ".$ext")"        # e.g. chalk-seattle, chalk-animated, chalk
    plat="${base%%-*}"                     # platform = text before first "-"
    variant="${base#*-}"                   # text after first "-"
    [ "$variant" = "$base" ] && variant="main"   # no "-" -> default variant
    case " $PLATFORMS " in
      *" $plat "*) ;;
      *) echo "warning: skipping $f (unknown platform '$plat')" >&2; continue ;;
    esac
    staged="$STAGE/${plat}_${variant}_screenshot.${ext}"
    cp "$f" "$staged"
    SHOTS+=("$staged")
  done
fi

echo "Publishing $NAME $VERSION ..."
# Publish through the wrapper so existing appstore screenshots are REPLACED, not
# appended to (pebble-tool hardcodes replaceScreenshots=false, which duplicates
# them on every publish). Run it with the same interpreter that backs the
# `pebble` launcher so pebble_tool is importable. cwd is the repo root here.
PEBBLE_PY="$(sed -n '1s/^#!//p' "$(command -v pebble)")"
"$PEBBLE_PY" scripts/pebble_publish.py \
  --non-interactive \
  --no-gif-all-platforms \
  --name "$NAME" \
  --version "$VERSION" \
  --category "$CATEGORY" \
  --description "$(cat store/description.txt)" \
  --release-notes "$NOTES" \
  --icon-small resources/images/icon_small_48.png \
  --icon-large resources/images/appstore_icon.png \
  ${SHOTS:+--screenshots "${SHOTS[@]}"} \
  "$@"
echo "Done."
