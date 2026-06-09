#!/usr/bin/env bash
# Cut a release: bump the version, commit it to master, then create the
# GitHub release with the built .pbw attached.
#
# Steps:
#   1. bump package.json version (patch by default)
#   2. test + build all platforms
#   3. commit the bump and push to master
#   4. gh release create vX.Y.Z with auto-generated notes
#
# Usage:
#   scripts/release.sh            # patch bump (1.0.1 -> 1.0.2)
#   BUMP=minor scripts/release.sh # 1.0.1 -> 1.1.0
#   BUMP=major scripts/release.sh # 1.0.1 -> 2.0.0
set -euo pipefail
cd "$(dirname "$0")/.."

BUMP="${BUMP:-patch}"

# Refuse to release from a dirty tree -- the only change we want to commit is
# the version bump itself.
if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is dirty; commit or stash changes first" >&2
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "master" ]; then
  echo "error: releases are cut from master, but you are on '$branch'" >&2
  exit 1
fi

# Make sure we are releasing on top of what is already on the remote.
git pull --ff-only origin master

# Test before mutating anything -- a test failure here leaves the tree clean so
# the release can simply be re-run after a fix.
node --test

# Bump the version in package.json without letting npm commit or tag it -- we
# handle the commit and tag (via gh release) ourselves.
npm version "$BUMP" --no-git-tag-version >/dev/null
VERSION="$(python3 -c "import json;print(json.load(open('package.json'))['version'])")"
TAG="v$VERSION"

# If the build fails after the bump, revert package.json so the dirty-tree
# guard doesn't block the next attempt. Cleared once the bump is committed.
trap 'git checkout -- package.json' ERR

echo "Releasing Pebble Tides $VERSION ..."

# Build after the bump so the .pbw embeds the new version.
pebble build

git add package.json
git commit -m "chore: bump version to $TAG"
trap - ERR
git push origin master

gh release create "$TAG" build/*.pbw \
  --title "Pebble Tides $VERSION" \
  --generate-notes

echo "Done. Released $TAG."
