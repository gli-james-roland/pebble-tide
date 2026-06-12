#!/usr/bin/env bash
# Single source of truth for release notes: CHANGELOG.md. Used by release.sh
# (GitHub release notes) and publish.sh (appstore release notes) so both post
# the same per-version notes.
#
#   changelog.sh extract <version>      print the notes body for a version
#   changelog.sh promote <version> <date>   turn [Unreleased] into [version] - date
#
# Headings look like "## [1.0.3] - 2026-06-12" or "## 1.0.3". The version match
# is on the first token after "## ", brackets stripped.
set -euo pipefail
cd "$(dirname "$0")/.."

CHANGELOG="CHANGELOG.md"

# Print the body of one version's section (heading excluded), trimmed of leading
# and trailing blank lines. Empty output means the version has no section.
extract() {
  local version="$1"
  awk -v ver="$version" '
    /^## / {
      if (insec) { exit }
      h = $0; sub(/^##[ \t]+/, "", h); gsub(/[\[\]]/, "", h)
      split(h, a, /[ \t]/)
      if (a[1] == ver) { insec = 1 }
      next
    }
    insec { body = body $0 "\n" }
    END {
      sub(/^\n+/, "", body); sub(/\n+$/, "", body)
      if (length(body)) { print body }
    }
  ' "$CHANGELOG"
}

# Rename the [Unreleased] heading to "[<version>] - <date>" and insert a fresh
# empty [Unreleased] above it. The existing unreleased bullets become the new
# version's notes.
promote() {
  local version="$1" date="$2"
  grep -qE '^## \[Unreleased\]' "$CHANGELOG" || {
    echo "error: no '## [Unreleased]' heading in $CHANGELOG" >&2
    exit 1
  }
  awk -v ver="$version" -v d="$date" '
    !done && /^## \[Unreleased\]/ {
      print "## [Unreleased]"
      print ""
      print "## [" ver "] - " d
      done = 1
      next
    }
    { print }
  ' "$CHANGELOG" > "$CHANGELOG.tmp"
  mv "$CHANGELOG.tmp" "$CHANGELOG"
}

cmd="${1:-}"
case "$cmd" in
  extract) [ $# -eq 2 ] || { echo "usage: changelog.sh extract <version>" >&2; exit 2; }
           extract "$2" ;;
  promote) [ $# -eq 3 ] || { echo "usage: changelog.sh promote <version> <date>" >&2; exit 2; }
           promote "$2" "$3" ;;
  *) echo "usage: changelog.sh extract <version> | promote <version> <date>" >&2; exit 2 ;;
esac
