# Changelog

Release notes for Pebble Tides. The release scripts read these: `release.sh`
promotes `[Unreleased]` to the new version and posts it as the GitHub release
notes; `publish.sh` posts the matching version's section to the appstore.

Write the next release's notes as bullets under `## [Unreleased]`.

## [Unreleased]
- Australia and the South Pacific tide coverage via the Bureau of Meteorology (BOM).
- Fixed a pan-animation warning ("animation.c ... does not exist") on tide stepping.
