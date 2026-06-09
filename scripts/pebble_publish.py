#!/usr/bin/env python3
"""Run `pebble publish`, but REPLACE the appstore screenshots instead of
appending to them.

pebble-tool hardcodes ``replaceScreenshots="false"`` on the release-upload
request (pebble_tool/commands/publish.py, _upload_release). The appstore then
keeps every prior screenshot and tacks the new ones on, so each publish stacks
another duplicate copy on the listing. The server already honors
``replaceScreenshots="true"`` to drop the existing set and use only the uploaded
one -- there's just no CLI flag to send it.

This wrapper flips that single form field to "true" and then delegates to the
real publish command, untouched. Only the release upload carries the field, so
new-app creation and every other request are left alone.

Run it with the interpreter that has pebble_tool installed (the one behind the
`pebble` launcher). Any extra arguments are forwarded to `pebble publish`.
"""
import sys

from pebble_tool import run_tool
from pebble_tool.commands.publish import PublishCommand

# The unbound original; every screenshot-bearing upload funnels through here.
_original_post = PublishCommand._post_with_wait_bar.__func__


def _post_replacing_screenshots(cls, url, headers, data, files, timeout, label):
    if isinstance(data, dict) and "replaceScreenshots" in data:
        data = dict(data)
        data["replaceScreenshots"] = "true"
    return _original_post(cls, url, headers, data, files, timeout, label)


PublishCommand._post_with_wait_bar = classmethod(_post_replacing_screenshots)


if __name__ == "__main__":
    sys.exit(run_tool(["publish", *sys.argv[1:]]))
