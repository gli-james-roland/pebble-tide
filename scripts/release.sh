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

# Release notes come from CHANGELOG.md. Require a non-empty [Unreleased] section
# before mutating anything, so we never cut a release with empty notes.
if [ -z "$(scripts/changelog.sh extract Unreleased)" ]; then
  echo "error: write release notes under '## [Unreleased]' in CHANGELOG.md first" >&2
  exit 1
fi

# Test before mutating anything -- a test failure here leaves the tree clean so
# the release can simply be re-run after a fix.
node --test

# Bump the version in package.json without letting npm commit or tag it -- we
# handle the commit and tag (via gh release) ourselves.
npm version "$BUMP" --no-git-tag-version >/dev/null
VERSION="$(python3 -c "import json;print(json.load(open('package.json'))['version'])")"
TAG="v$VERSION"

# If the build fails after the bump, revert package.json and CHANGELOG.md so the
# dirty-tree guard doesn't block the next attempt. Cleared once committed.
trap 'git checkout -- package.json CHANGELOG.md' ERR

echo "Releasing Pebble Tides $VERSION ..."

# Promote the [Unreleased] notes to this version + date, then capture them for
# the GitHub release. CHANGELOG.md is committed with the version bump below.
scripts/changelog.sh promote "$VERSION" "$(date +%F)"
NOTES="$(scripts/changelog.sh extract "$VERSION")"

# Build after the bump so the .pbw embeds the new version.
pebble build

git add package.json CHANGELOG.md
git commit -m "chore: bump version to $TAG"
trap - ERR
git push origin master

NOTES_FILE="$(mktemp)"
printf '%s\n' "$NOTES" > "$NOTES_FILE"
gh release create "$TAG" build/*.pbw \
  --title "Pebble Tides $VERSION" \
  --notes-file "$NOTES_FILE"
rm -f "$NOTES_FILE"

echo "Done. Released $TAG."
