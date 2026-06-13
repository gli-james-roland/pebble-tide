# Phone localStorage budget and the region cap and eviction policy

Status: accepted

## Decision

The region cache (ADR 0006) is bounded by both a Station count and a byte budget,
and orphaned blobs are evicted by diffing an authoritative id list — never by
iterating `localStorage`.

- **Budget.** Assume ~5 MB `localStorage`, conservatively. Reserve for the
  catalog cache (~0.5 MB), config, and headroom, leaving a region blob budget of
  ~**2.5 MB**.
- **Cap.** Default `cap = 400` Stations (~1.8 MB at ~4.5 KB/blob). Hard max 500.
- **Enforce both.** Selection and download track the running Station count *and*
  the running byte total. Hitting either stops the download and sets
  `truncated = true` with a note ("cached nearest 400 of 920 stations"). Because
  Stations are selected nearest-first, truncation keeps the closest ones — the
  ones the user is most likely to be near.
- **A `setItem` quota failure mid-download** stops the download and marks the
  region truncated rather than throwing.
- **Storage encoding.** Each blob is stored base64-encoded
  (`tideBlob:<id>.b64`), not as a JSON number array.
- **Eviction.** Orphan blobs (a previous region's leftovers) are removed by
  diffing the cached `tideBlob:*` ids against `region.stations`. We do **not**
  enumerate `localStorage` keys.

## Context

The region cache is the largest thing the phone app stores, and `localStorage` is
the only durable store PKJS has. The Pebble phone app provides ~5 MB of Web
Storage, shared across the catalog cache, config, and the region blobs. Without a
budget, a dense radius could pull 1,000+ Stations and overflow the quota
mid-download (see the catalog counts in ADR 0006).

Encoding matters at this scale. A packed blob is ~3 KB binary. Base64 inflates it
~33% to ~4.5 KB; serializing the same bytes as a JSON array of decimal numbers
("[255,12,...]") averages ~4 characters per byte, roughly 3× larger. At hundreds
of blobs that difference is the gap between fitting and not fitting.

Finding orphan blobs is where pypkjs bites. `localStorage.key(n)` is O(n) on
pypkjs and its iteration order is unstable — a known footgun in this repo.
Scanning all keys to find `tideBlob:*` entries would be O(n²) over hundreds of
keys and could miss or double-visit entries as the store mutates. The region
record already carries the authoritative Station id list, so eviction can diff
against it and skip enumeration entirely.

## Considered options

- **Count cap only.** Simple, but a worst-case blob mix can still blow the byte
  quota before the count cap is reached. Rejected: the quota is the real wall.
- **Byte budget only.** Tracks the true constraint, but the cap doubles as a
  request-volume guard (it bounds how many providers we hit) and a predictable
  download time. Kept alongside the byte budget.
- **Both count and byte budget, nearest-first (chosen).** The count bounds
  request volume and download time; the byte budget bounds storage. Nearest-first
  selection means whichever limit truncates first, the cache keeps the closest
  Stations.
- **JSON number-array blob storage.** Avoids base64 decode on read, but ~3× the
  size. Rejected — size is the binding constraint here.
- **Evict by scanning `localStorage` keys.** The obvious approach, rejected
  because pypkjs `key()` is O(n) and unstable; id-list diff is correct and cheap.

## Consequences

- Truncation is expected and visible, not an error. The config readout reports
  the cached count against the available count ("cached nearest 400 of 920").
- The region record's `stations` id list is load-bearing for eviction. If it ever
  drifts from the actual `tideBlob:*` keys, orphans leak; correctness depends on
  writing the record after the blobs and diffing on every pin.
- Base64 storage costs a decode on read and an encode on write per blob. At one
  blob served per launch the read cost is negligible; the write cost is paid once
  per pin during the background download.
- Raising the cap toward the hard max 500 trades headroom for coverage; the
  ~2.5 MB budget is the ceiling regardless, so a generous cap on small blobs and
  the byte budget on large ones each backstop the other.
