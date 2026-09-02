# The room server — DjRoom and RelayRoom

The client half of shared sessions is [shared-session.md](./shared-session.md); the
sync planes are compared in [sync.md](./sync.md). **This is the server** — two
Durable Object classes in `server/room.ts` (1.4k lines) and `server/relayRoom.ts`.

## Why a Durable Object at all

One DO per session, addressed by `idFromName(host session key)`. Everything follows
from one property: **a DO is single-threaded, so intents are totally ordered.**
There is no distributed consensus to get wrong; the room simply *is* the order in
which things arrived. It also **never sees audio or credentials** — only control
intents, track ids and opaque snapshots.

It uses the **WebSocket Hibernation API**, so an idle room costs nothing: sockets
survive eviction and the DO wakes on the next frame. That is why per-socket state
lives in a serialized `Attachment` rather than in instance fields — an evicted DO
loses its heap, not its attachments.

## The split, and why

| File | Holds |
|---|---|
| `roomState.ts` | the **pure** model — `Attachment`, roles, the pub allowlist, the welcome/presence payload shapes. Testable with no DO |
| `roomCrowd.ts` | Reactions, Requests, Chat — crowd features, separable |
| `room.ts` | the stateful plumbing: socket lifecycle, membership transitions, the anchor, fan-out, persistence |
| `relayRoom.ts` | `RelayRoom` — the crowd-shard tier |

If you are adding a rule about *who may do what*, it belongs in `roomState.ts`
where it can be tested. `room.ts` should stay plumbing.

## Two switches, not roles

Each device independently sets **controlling** (🎛️ may drive — shared, many at
once) and **listening** (🔊 renders its own audio). `joined = controlling ||
listening`; both off is solo. One joined device is the **anchor** — the playhead
clock and snapshot authority. The anchor is invisible plumbing, *not* a role
anyone picks, and `canDriveIntent` (in the shared protocol module, so client and
server agree by construction) decides what a given peer may send.

## Scaling: the relay tier

A single DO tops out around **~500 sockets** for fan-out. Past that, the master
pushes crowd frames to `RelayRoom` shards (`RELAY_SHARDS`), each of which fans out
to its own slice — validated at N=1000. A late joiner on a shard needs to rebuild
"now", so each shard caches the last frame per kind (`cacheKindOf`: welcome /
state / automix / stemview / lyrics / live). **A new crowd frame type must be
added to `cacheKindOf` or late joiners will miss it** — it defaults to `live`,
which is the ephemeral bucket.

## The write quota, which caused a real outage

Cloudflare's free tier caps **daily DO writes**, and a naive "persist on every
change" blew it — sessions appeared to hang. The fixes are load-bearing:

- persists are throttled (`PERSIST_MIN_MS` = 10 s), with the in-memory copy staying live
  between writes;
- stem envelopes are large and best-effort — the relay does not trust the client's
  self-throttle;
- the client poll that backs the socket was widened 5 s → 30 s.

**Treat every `storage.put` in this file as a budgeted resource.** If you add one
to a per-frame path, throttle it.

## Presence offline — the alarm

The DO's one storage alarm. When an account's last socket drops,
`schedulePresenceOffline` queues it and arms an alarm `PRESENCE_GRACE_MS` out
(coalescing: it only arms if none is pending). On fire, the alarm re-checks for a
live socket — so a quick reconnect cancels the offline — and bridges the rest to
the Worker, which owns D1. The Worker's write is **LWW-guarded on the close
timestamp**, so an account that reconnected on a *different* DO cannot be stomped
offline.

> **Noted while documenting, not a live bug:** `alarm()` deletes `presenceOff`
> *before* the `if (!this.notifySecret || !this.origin) return` guard, so a config
> change between scheduling and firing would drop the queue silently. It is
> unreachable today because `schedulePresenceOffline` bails on the same condition
> before ever writing the key. Still the wrong order — delete after you know you
> can act — and worth a test if that guard ever moves.

## Where to read

`fetch` (upgrade + auth) → `webSocketMessage` (the intent switch, the bulk of the
file) → `webSocketClose` → `alarm`. The message switch is where a new intent kind
lands; add it to `protocol.ts` first so `canDriveIntent` covers it.
