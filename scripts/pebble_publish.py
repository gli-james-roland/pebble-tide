#!/usr/bin/env python3
"""Run `pebble publish`, but with two behaviors pebble-tool doesn't expose:

1. REPLACE the appstore screenshots instead of appending. pebble-tool hardcodes
   ``replaceScreenshots="false"`` on the release upload, so each publish stacks
   another duplicate copy on the listing. The server honors ``"true"``.

2. UPDATE the app description from ``--description`` on the release upload.
   pebble-tool only sends ``--description`` when CREATING an app; the
   release-upload path never sends it, so an existing app's description is never
   updated by publish. The proper ``PATCH /api/dashboard/apps/{id}`` route
   rejects the CLI's Firebase token (the web dashboard uses session auth), so
   the release POST is the only bearer-writable endpoint. We attach the
   description there. If the server rejects the extra field, we retry without it
   so a publish never fails over the description, then we read the live listing
   and report whether the description actually changed.

Run with the interpreter behind the ``pebble`` launcher, from the project root
(package.json is read for the app UUID during verification). Extra arguments are
forwarded to ``pebble publish``.
"""
import json
import sys

from pebble_tool import run_tool
from pebble_tool.commands.publish import PublishCommand

API_BASE = "https://appstore-api.repebble.com"

# Unbound original; every screenshot-bearing upload funnels through here.
_original_post = PublishCommand._post_with_wait_bar.__func__


def _description_from_argv(argv):
    for i, arg in enumerate(argv):
        if arg == "--description" and i + 1 < len(argv):
            return argv[i + 1]
        if arg.startswith("--description="):
            return arg.split("=", 1)[1]
    return None


_DESCRIPTION = _description_from_argv(sys.argv[1:])


def _rewind(files):
    # The first POST reads each file handle to EOF; rewind before any retry.
    for entry in files or []:
        try:
            entry[1][1].seek(0)  # (field_name, (filename, handle, mime))
        except Exception:
            pass


def _post_with_extras(cls, url, headers, data, files, timeout, label):
    # Only the release upload carries replaceScreenshots; leave other POSTs
    # (e.g. new-app create) untouched.
    if not (isinstance(data, dict) and "replaceScreenshots" in data):
        return _original_post(cls, url, headers, data, files, timeout, label)

    data = dict(data)
    data["replaceScreenshots"] = "true"
    if _DESCRIPTION:
        data["description"] = _DESCRIPTION

    resp = _original_post(cls, url, headers, data, files, timeout, label)

    # If (and only if) the server rejected the request *because of* the
    # description field, retry without it so the publish still goes through.
    if _DESCRIPTION and getattr(resp, "status_code", 200) >= 400:
        try:
            body = (resp.text or "").lower()
        except Exception:
            body = ""
        if "description" in body:
            print("note: release rejected the description field; retrying without it",
                  file=sys.stderr)
            retry = dict(data)
            retry.pop("description", None)
            _rewind(files)
            resp = _original_post(cls, url, headers, retry, files, timeout, label)
    return resp


PublishCommand._post_with_wait_bar = classmethod(_post_with_extras)


def _verify_description(expected):
    """Best-effort: read the live listing and report whether it matches the
    description we tried to set. Never raises -- verification must not fail a
    publish that already succeeded."""
    try:
        import requests
        from pebble_tool.account import get_account

        uuid = json.load(open("package.json"))["pebble"]["uuid"]
        token = get_account(auth_provider="firebase").get_access_token()
        me = requests.get(
            API_BASE + "/api/v1/developer/me",
            headers={"Authorization": "Bearer {}".format(token)}, timeout=30,
        ).json()
        lookup = (me.get("app_lookup") or {}).get("by_app_uuid") or {}
        app_id = lookup.get(uuid) or lookup.get(uuid.lower())
        if not app_id:
            print("note: couldn't resolve app id; skipping description check", file=sys.stderr)
            return

        payload = requests.get("{}/api/v1/apps/id/{}".format(API_BASE, app_id), timeout=30).json()
        app = payload.get("data")
        if isinstance(app, list):
            app = app[0] if app else {}
        live = ((app or {}).get("description") or "").strip()

        if live == expected.strip():
            print("description verified: live listing matches store/description.txt")
        else:
            print(
                "WARNING: description did NOT update -- the release endpoint ignored it.\n"
                "         Update it manually in the dashboard: {}/dashboard".format(API_BASE),
                file=sys.stderr,
            )
    except Exception as exc:  # noqa: BLE001 - best effort only
        print("note: description verification skipped ({})".format(exc), file=sys.stderr)


if __name__ == "__main__":
    rc = run_tool(["publish", *sys.argv[1:]])  # raises SystemExit on failure
    if _DESCRIPTION:
        _verify_description(_DESCRIPTION)
    sys.exit(rc)
