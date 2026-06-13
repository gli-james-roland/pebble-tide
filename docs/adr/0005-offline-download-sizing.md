# Offline download sizing within Pebble's 4 KB persist budget

Status: accepted

## Decision

A Pinned offline download holds up to **45 Days** of predictions on the watch, user-selectable as 7 / 15 / 30 / 45 (the **Offline Range**). To fit the largest choice, the watch's blob caps grow:

| Constant | Was | Now | Holds |
| --- | --- | --- | --- |
| `MAX_SUN_DAYS` | 16 | **48** | 45 forward + 1 back + margin of night shading |
| `MAX_POINTS` | 256 | **320** | 45 Days at up to ~7 Extrema/day |
| `MAX_BLOB_BYTES` | 2048 | **3072** | 71 (header) + 320×7 (2240) + 1 + 48×8 (384) = 2696 B, with headroom |

Total persisted (blob + len + 3 config ints) ≈ 3,088 B, under the documented **4 KB per-app** persistent-storage limit. The blob record **format is unchanged** — only buffer/cap sizes grow — so no `BLOB_VERSION` bump and a blob written by the old version still parses.

The Offline Range applies only in **Pinned Mode**. **Auto Mode** keeps its short ~8-Day window, refreshed daily.

## Context

"Download a bunch of data" is bounded by the watch, not the APIs. Pebble allots each app 4 KB of persistent storage (256 B per field). The blob is the dominant consumer, chunked across persist fields. Per day it costs ~36 B (≈4 Extrema × 7 B + 8 B sun), against ~71 B fixed header plus a handful of config ints — a theoretical ceiling near 95 Days, so 45 sits comfortably inside with room to grow later.

Auto Mode is excluded deliberately: it runs online and refetches daily, so pulling 45 Days on every wake would burn bandwidth and battery for data replaced the next day. The long horizon exists only for the deliberate go-offline case (Pinned Mode, see ADR 0004).

## Considered options

- **Keep 8 Days for everyone.** Simplest, no storage change, but defeats the offline use case.
- **Fixed 45 Days.** One horizon, no config. Rejected so users can trade sync size/time against how far ahead they need.
- **User-selectable 7/15/30/45, caps sized for the 45 max (chosen).** Buffers hold the largest choice; smaller ranges pack smaller blobs. Costs the cap bumps above and a longer sync at 45 Days (48 vs 32 AppMessage chunks).

## Consequences

- The bump to `MAX_SUN_DAYS`/`MAX_POINTS`/`MAX_BLOB_BYTES` raises the watch RX buffer and per-point RAM arrays; well within app RAM on the targets.
- A 45-Day blob is ~48 AppMessage chunks vs ~32 today — a slightly longer one-time sync when pinning.
- BOM Stations serve predictions only to the end of the calendar year, so a late-year 45-Day pin yields fewer Days — graceful, no special handling.
- Future horizons beyond 45 are possible (up to ~90 Days) by raising `MAX_BLOB_BYTES` toward ~3,584 while staying under 4 KB; the 4 KB wall is the hard limit.
