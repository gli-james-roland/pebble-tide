#!/usr/bin/env python3
# Write a region cache (from seed-region.js on stdin) into the emulator's
# pypkjs localStorage, which is a dbm.dumb store keyed by the app UUID. The
# emulator MUST be stopped first so pypkjs has flushed and closed the db.
#
# Usage: node scripts/seed-region.js "..." 25 45 400 | python3 scripts/seed-region.py [platform]
import sys, os, json, glob, dbm.dumb

platform = sys.argv[1] if len(sys.argv) > 1 else "gabbro"

with open(os.path.join(os.path.dirname(__file__), "..", "package.json")) as f:
    uuid = json.load(f)["pebble"]["uuid"]

# Pebble SDK keeps per-platform emulator data under Application Support; the
# version dir varies, so glob for it.
base = os.path.expanduser("~/Library/Application Support/Pebble SDK")
matches = glob.glob(os.path.join(base, "*", platform, "localstorage"))
if not matches:
    # dbm.dumb.open(...,'c') will create it, but only if the parent exists.
    matches = sorted(glob.glob(os.path.join(base, "*", platform)))
    if not matches:
        sys.exit("no emulator data dir for platform '%s' under %s — boot it once with `pebble install --emulator %s`" % (platform, base, platform))
    ls_dir = os.path.join(matches[-1], "localstorage")
    os.makedirs(ls_dir, exist_ok=True)
else:
    ls_dir = sorted(matches)[-1]

db_path = os.path.join(ls_dir, uuid)
payload = json.load(sys.stdin)

db = dbm.dumb.open(db_path, "c")
try:
    db["tideRegion"] = json.dumps(payload["region"])
    for sid, rec in payload["blobs"].items():
        db["tideBlob:" + sid] = json.dumps(rec)
finally:
    db.close()

print("seeded %d blobs + region into %s" % (len(payload["blobs"]), db_path))
