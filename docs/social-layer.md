# Social Layer — Project Plan

The social upgrade for htl: turn the room from a private multi-device control
session into a **first-class social object** that scales from small parties to
hundreds of listeners, add **public identity (profiles + handles)** and a
**follow graph**, and split the current control session into two planes so big
rooms are cheap. Builds on `docs/shared-session.md` (the DjRoom control bus).

## Decisions locked

- **Host is liable for broadcast content** — handled in **ToS**, same posture as
  today ("the user is responsible for their library"). Public rooms are NOT
  gated on a legal redesign.
- **Fully free, no monetization or creator incentive** anywhere. No tiers, no
  paywalled rooms, no tips, no payouts. (Removes a whole cross-cutting concern.)
- **Broadcast model = recipe, not audio.** Listeners reconstruct the mix locally
  via the bit-exact engine from a transport clock + deck-param stream. Audio
  fan-out (SFU) is explicitly out of scope for v1.
- **Handle charset v1 = ascii `[a-z0-9_]`, 3–20, case-folded.** Unicode handles
  deferred (homoglyph risk).
- **Handle attaches to the account (human), provider-independent.** Never an
  auth factor — login stays on OAuth.

## North-star architecture: two planes

1. **Control plane** — existing DjRoom DO. Authoritative, small set of *writers*
   (host + co-controllers). Largely unchanged.
2. **Broadcast plane** — read-mostly fan-out the control room publishes a digest
   to (now-playing, transport clock, deck/crossfader snapshot, cue events,
   presence count, reactions). Scales independently via a relay tier.

A listener "stepping up to the decks" = moving from plane 2 → plane 1.

## Review log — 2026-06-16 (plan re-validated, still good)

Codebase swept; the day's commits (`1d182e0` EQ Pro-Q, `97d962b` FX rack+sampler,
`39d3285` stem-aware automix, mobile fixes) all landed in FX/audio — identity and
the room transport are untouched. Concrete deltas folded below:

- **Migration numbering:** next free = **0012**. `0010_identity` is `track_identity`
  (acoustic fingerprint), NOT user identity — don't reuse the name.
- **A2 confirmed live:** `upsertGoogleUser` (`server/db.ts`) still
  `UPDATE users SET email=?, name=?, avatar=?` on every login. Stomp bug is real.
- **The two toggles E4/E5 replaces are named** `controlling` / `listening`
  (`src/htl/room/protocol.ts`, patched in `server/room.ts`). The existing
  **knock → approve/deny/kick** handshake is the seed of E6's request-to-play —
  but it's built for PRIVATE rooms where even *listening* needs host approval.
  **Public rooms invert that default:** listening is open (no knock); only
  *taking the decks* knocks. (New task E6a below.)
- **No listener/controller plane split exists yet:** every joined device is a full
  WS peer in one DjRoom DO eating the entire relay. 300 listeners = 300 peers on
  the control firehose. Epic D is exactly this fix — confirmed needed.
- **Recipe-not-audio is already the implemented reality** (`listening` = each device
  renders locally from ticks/snapshots). Epic D *scales* it, doesn't introduce it.
- **NEW room state:** `7422bf3` made the auto-mix queue first-class
  host-authoritative state streamed to guests (`queue` intents + `automix` msg).
  D1 broadcast digest + D3 late-join snapshot must carry it (noted inline).
- **Structural:** today **room identity == account identity** (one DjRoom per
  account). E1's "findable venue" needs the room decoupled into its own
  addressable object — a bigger lift than E1 first implied (noted inline).

## Open decisions to lock before building the dependent epic

- **URL shape:** `/@handle` vs `/u/handle` (gates the reserved-handle list and
  routing). → Epic A.
- **One handles namespace or two** (user handles vs venue handles). → Epic A/H.
- **Feed fan-out:** on-write vs on-read for "live now from follows." → Epic C/J.
- **Max room size cap** and its at-cap failure mode (reject / queue / overflow
  relay). → Epic E.
- **Local catch-up policy:** skip-to-live vs slow-pull for drifting listeners. → Epic D.
- **Recording retention/ownership** defaults. → Epic G.

---

# Phases (suggested sequencing)

- **P0 — Identity foundations** (A): split columns, kill stomp bug, handles, claim flow. *Unblocks everything social.*
- **P1 — Public profile + graph** (B, C): profile surface, follow/block graph.
- **P2 — Two-plane rooms** (D, E): broadcast plane, relay tier, room lifecycle, seat UX.
- **P3 — Crowd channel** (F): requests, reactions, chat, hype.
- **P4 — Async + discovery** (G, J): recorded sets, tracklists, directory, feed, cold-start.
- **P5 — Notifications, presence, safety, privacy, mobile** (I, K, L, M, N): cross-cutting hardening.
- **Cross-cutting:** O (ToS), runs alongside P2 launch.

Critical path: **A → D → E**. B/C can run parallel to D once A lands.

---

# Epics & tasks

## A. Identity & handles  *(P0, foundational)*

> **Backend slice DONE 2026-06-16** (migration `0012_handles.sql`, `server/db.ts`,
> `server/security.ts`, `server/accounts.ts`, `server/security.test.ts`; 38 tests
> green, worker dry-run clean). Routes shipped: `GET /api/handle/check?h=`,
> `POST /api/me/handle`, `PUT /api/me/profile`; `/api/me*` now return the public
> identity via `publicIdentity()`.
>
> **Claim UI DONE 2026-06-16** (`src/htl/account/index.ts` +
> `src/components/ProfileScreen.tsx` + `src/styles.css`): the Profile screen shows
> the public `@handle` (or a "Claim your @handle" CTA) and an inline editor with
> debounced live availability against `/api/handle/check`, claiming via
> `/api/me/handle`. tsc 0 errors, 38 tests, build green.
>
> **A6 public `/@handle` page DONE 2026-06-16** (`server/accounts.ts` +
> `server/api.ts` `GET /api/u/:handle`, `src/components/PublicProfileScreen.tsx`,
> one-line `App.tsx` mount). **A11 satisfied by design. A9 rename cooldown
> DONE** (7-day gate). Public profile **folds into the shared right dock** (mutually
> exclusive w/ Settings/Profile/Session). **Only A10** (recycle/tombstone) remains —
> blocked on M3 account-deletion, which doesn't exist yet.
> Decision taken: handle is **NULL until claimed** (no stored placeholder) — an
> un-claimed account is fully usable but not publicly addressable until it opts in.

- [x] **A1. Split user identity columns.** `display_name`/`avatar_url`/`bio`
      (user-owned) added distinct from the Google-mirror `name`/`avatar`.
      Public read = `display_name ?? name`, `avatar_url ?? avatar`.
- [ ] **A2. Fix the login-stomp bug.** `upsertGoogleUser` (`server/db.ts`) must
      update only `google_*` + `email` + `last_login`, NEVER the user-owned fields.
      *(Confirmed still present 2026-06-16.)*
- [x] **A3.** `handle` + `handle_folded` columns with **DB-level UNIQUE on the
      fold** (`idx_users_handle_folded`); `setUserHandle` returns "taken" on the
      atomic conflict (pre-check + failing-UPDATE catch), not an app-only check.
- [x] **A4. Handle validation** (`validateHandle` in `security.ts`): charset
      `[A-Za-z0-9_]`, len 3–20, NFKC+lowercase fold for uniqueness, case preserved.
- [x] **A5. Reserved-handle seed list** (`RESERVED_HANDLES`): routes + impersonation
      targets + profanity seed, checked on the fold. *(Leetspeak evasion = later.)*
- [x] **A6. URL shape + routing — `/@handle`.** Public read `GET /api/u/:handle`
      (public fields only, never email/connections; Worker + dev parity); client
      `fetchPublicProfile`; self-contained `PublicProfileRoute` (no app router — reads
      `location.pathname`, follows popstate) mounted once in `App.tsx`; SPA fallback
      serves direct navigations. Reserved names already enforced by `validateHandle`.
- [x] **A7. Claim-handle flow.** API + Profile-screen claim/rename editor (debounced
      availability) done. *(First-run forced gating + `/@handle` public page = later.)*
- [x] **A8. Backfill** — handle is nullable + `ensureIdentityColumns()` adds the
      columns to older/local DBs. **Decision: no stored placeholder** — un-claimed
      rows stay handle-NULL (usable, not publicly addressable). Supersedes the
      original `user-ab12cd` idea; un-claimed users render a derived label client-side.
- [x] **A9. Rename cooldown** — 7-day gate between renames (`HANDLE_RENAME_COOLDOWN_MS`,
      enforced in `setUserHandle` + dev `setHandle`; first claim free; message shows in
      the editor). *(Still TODO when graphs land: don't instantly free the old handle;
      store mentions/links by user `id` and render the current handle.)*
- [ ] **A10. Recycle policy on deletion:** tombstone (don't recycle) or long
      quarantine. (See M3 deletion cascade.)
- [x] **A11. Multi-provider future-proofing — satisfied by design.** The handle
      lives on the `users` row (keyed by account `id`), independent of the
      `connections` table, so it already survives any future provider link/merge.
      Login stays Google-only; adding "Sign in with X" = an account-link step that
      doesn't touch the handle. *(Revisit if a true account-merge flow is built.)*

## B. Public profile surface  *(P1)*

> **Buildable slice DONE 2026-06-16** (`ProfileScreen.tsx` ProfileEditor +
> public block, `server/accounts.ts`/`server/api.ts` B7 fix). tsc 0, 38 tests,
> build green. B3/B5/B6 wait on later epics (rooms D / async G / graph C).

- [x] **B1. Separate public vs private.** Own Profile now has a distinct **public**
      block (display name + bio + "View public profile →" to `/@handle`); email +
      connections stay the private account bits behind the owner-only eye toggle.
- [x] **B2. Public profile object** — display name + bio editable via `ProfileEditor`
      (PUT `/api/me/profile`, never touches the Google-mirror). *(Custom avatar
      upload deferred — public avatar = letter fallback until set; needs R2.)*
- [ ] **B3. Live status on profile** ("on the decks now → join"). *(Needs Epic E.)*
- [x] **B4. Top songs** (existing play counts) — shown on own + public profile.
- [ ] **B5. Past sets / venues hosted** list (depends on G).
- [x] **B6. Follower / following counts** on own + public profile (Epic C).
      *(List UI deferred — `/api/{followers,following}` endpoints exist.)*
- [x] **B7. Never leak email or Google legal name publicly.** `/api/u/:handle` now
      returns `display_name`-or-null (no `name` fallback) + `avatar_url`-or-null (no
      Google avatar); the `/@handle` UI shows the @handle when display name is unset.

## C. Social graph  *(P1)*

> **Graph core DONE 2026-06-16** — migration `0013_graph.sql` (`follows` + `blocks`);
> `db.ts` follow/unfollow/block/unblock + `relationship`/`followCounts`/list fns;
> `accounts.ts` `POST /api/{follow,unfollow,block,unblock}` + `/api/{followers,following}`
> + counts/relationship/isSelf on `/api/u/:handle` + own counts on `/api/me/profile`;
> Follow/Block UI + counts on the public profile, own counts on the Profile screen.
> tsc 0, 38 tests, build + dry-run green. **Block hides the blocker from the blockee's
> profile (404).** Multi-user follow needs the Worker (`pnpm worker`) — dev is single-user.

- [x] **C1. Follow model** (asymmetric) — `follows(follower_id, followee_id)`, idempotent,
      blocked-either-way rejected; counts + lists + Follow/Following/Follow-back button.
- [x] **C2. Friends = mutual follow**, derived (`relationship.mutual`), shown on the profile.
      *(The "accept" variant for private-session access stays an E-epic concern.)*
- [x] **C3. Negative graph: block** — `blocks` table, block drops follows both ways,
      blocked user can't follow you and can't see your profile (404). *(Mute = a chat
      concept, deferred to F/L. Room-level block enforcement lands with E.)*
- [~] **C4. Celebrity hot-row** — indexed `follows(followee_id)` + paginated lists now;
      counts are `COUNT(*)` (fine at current scale). **TODO:** denormalize a per-user
      counter column if any account's list grows large enough that COUNT(*) hurts.
- [ ] **C5. Discoverability opt-in:** lookup-by-handle already works (public `/@handle`);
      by-email / Spotify-graph matching deferred (opt-in only when built).

## D. Broadcast plane & deterministic reconstruction  *(P2, critical path)*

> **Design settled 2026-06-16 (build approved).** Spine principles:
>
> - **One engine, two surfaces.** A room has WRITERS (`controlling`) and READERS
>   (`listening`-only). Private session = mostly writers; public room = few writers
>   + many readers + a shareable id + anon access. Every D upgrade lands on both;
>   the writer path is **unchanged**, so private feel is preserved by construction.
> - **Role picks the stream, `listening` only gates audio render.** `controlling`
>   (±listening) → the full **writer stream** (intents + tick), exactly as today.
>   `listening`-only → the curated **digest** (resolved state + sparse anchors).
>   So **control+listen = today, byte-for-byte** — the digest never touches a
>   controller. Stepping up/down the decks = a digest⇄writer-stream **subscription
>   swap** (this is the seat/stage transition, made literal).
> - **No new clock.** The session already runs local-playhead + periodic re-anchor
>   ("desktop playhead real-clock"); the instant feel comes from *event* pushes over
>   the WS, identical for listeners. "Loose" only meant absolute-position precision,
>   which is invisible (listeners render independently, never hear each other).
> - **Stem state is already resolved + authoritative in the tick** (`DeckTick.stems
>   {g,m}`, self-heals a dropped intent) → listeners get the live stem mix from the
>   digest, no raw intent needed. Stem mixing is pure-parameter (no gestures) → it
>   reconstructs faithfully; it's the *showcase*, not the hard case.
> - **Stems-from-R2, cache-only.** Listeners (mobile included) DOWNLOAD cached stems;
>   never separate. The host decides stem availability and bears the separation cost
>   to warm the cache; uncached → graceful full-track (non-stem) mix for everyone.
> - **Room-id = handle→home.** DO stays keyed `home:${accountId}` (private unchanged).
>   A public listener addresses a room by the host's `@handle` → resolve → join that
>   `home:` DO as anon, read-only, no invite — gated by a host `public` flag.
> - **Presence at scale = a count, not a list.** Public listeners are excluded from
>   the roster + anchor eligibility; surfaced as `listeners: N`.
>
> **Build order:** D-1 server foundation (public flag + anon read-only listener by
> handle + count) → digest curation/roll-up → stems-from-R2 (Deck.ts, *after* the FX
> agent settles) → relay-tier seam → clock/late-join hardening.
>
> **D-1 SHIPPED 2026-06-16 (transport layer, build-green, uncommitted).** Files:
> `protocol.ts` (`{t:"public"}` + `listeners`/`public` on welcome/presence),
> `room.ts` (`pub` role: anon read-only admission gated on the host `public` flag,
> excluded from roster + anchor, surfaced as `listenerCount()`, read-only message
> guard, host `public` toggle that evicts on close), `worker/index.ts` (`?room=@handle`
> → resolve → `home:${hostId}` as `pub=1`, anon-ok, un-forgeable), `client.ts`
> (`listenHandle` read-only connect mode + `goPublic()` + `listeners` handler).
> A listener tunes in by handle and receives the live board (catch-up snapshot + tick +
> relayed state) → reconstructs the mix locally. **Functional for non-stem mixes now.**
> **Deferred:** the UI (host "Go live" toggle + a listener tune-in entry — both live in
> the FX-agent-contended `App.tsx`/components); digest curation (drop raw intents for
> readers — currently they get the full relay, which works but isn't optimized);
> stems-from-R2 (so stem mixes reconstruct on listeners — needs `Deck.ts`).
>
> **Curation note (2026-06-16):** snapshots are **catch-up-only** (`App.tsx:559`);
> live board changes ride the *intents*, so readers genuinely need most intents today
> — wholesale intent-dropping would break live reader rendering. Full "resolved-delta
> digest" (roll up continuous sweeps into frequent resolved state) therefore needs the
> publish cadence reworked in `App.tsx` (FX-agent-contended). Done now, the safe
> pure-`room.ts` slice: **`jog` (gestural scrub) is no longer fanned to public
> listeners** (`relay(..., skipListeners)`) — non-reconstructable for them, they resync
> via the tick. Continuous `control`/`stemGain` sweeps still relay (readers need them
> to hear the live mix) until the roll-up lands.

> ## SCALE — status + the two big lifts (READY-TO-BUILD specs, demand-gated)
>
> **DONE (hundreds tier, committed):** Phase 1 `ab844d6` — presence **coalesce**
> (leading-edge 1s throttle) + **split** (roster→participants, count→crowd), killing the
> O(N²) join storm (the real ceiling). Phase 2 `b4f79b1` — host-disconnect **anchor grace**
> (8s), **MAX_LISTENERS=500** cap (503 "full"), reconnect **jitter**. A single DjRoom is now
> solid for a few hundred listeners. **DEFER the two below until a room actually nears 500**
> — they're thousands-scale, and building them blind (no real load to validate) is the wrong
> call. The seam already exists: Phase 1's `flushPresence` proves the publish-set is split
> from the socket-set; a relay subscribes to the same per-listener output.
>
> ### D1 — Digest intent roll-up (build first; it's contained, room.ts-only)
> Today listeners get the FULL intent relay (minus `jog`). Roll-up = the DO curates the
> *listener* stream while WRITERS keep every intent (instant feel):
> - **Drop** gestural (`jog` — already done).
> - **Coalesce** continuous sweeps (`control`/`crossfade`/`stemGain`/`fxParam`) per
>   `(kind,deck,param)` to a capped rate (~20–30 Hz) — last-value-wins, flushed on a timer.
>   Split the relay: `relayToWriters` immediate, `relayToListeners` coalesced.
> - **Pass through** discrete events (`load`/`cue`/`loop`/`transport`/`hotcue`/`fxRack`) to
>   listeners immediately.
> - **CAVEAT:** coalescing crossfade/EQ to ~20 Hz can zipper unless the reader RAMPS gains to
>   the new value over the flush interval (engine change: `setCrossfade`/EQ `linearRampTo`).
>   Without the ramp, keep the rate ≥30 Hz. This is why it's deferred — marginal fan-out win
>   (presence was the real cost) for new audio-quality risk.
>
> ### D2 — Relay tier (the thousands-scale lift; build only on real demand)
> One DjRoom is single-threaded → O(N) sends/message caps it ~hundreds. To shard:
> - **New `RelayRoom` DO.** Holds a SHARD of listener WebSockets. Receives digest pushes
>   from the master and fans out to its shard. Read-only (no writer messages).
> - **Master publishes once → R relays.** The master (DjRoom) pushes each digest frame
>   (tick/state/curated-intent/stemview/presence-count) to relay DOs by id
>   (`relay:{roomId}:{0..R-1}`) via DO-to-DO fetch/RPC. Master fan-out is now O(R), not O(N).
> - **Worker shards listeners.** On a `?room=@handle` pub connection, the Worker assigns a
>   relay index (`hash(deviceId) % R` or least-loaded) and routes the WS to that RelayRoom
>   instead of the master. Participants still hit the master directly.
> - **Catch-up:** each relay caches the last snapshot/stemview it received so a late joiner
>   gets it without round-tripping the master.
> - **R sizing:** start R=1 (relay == a second DO) and grow; `MAX_LISTENERS` becomes per-relay.
> - **Hard parts (why real load matters):** relay liveness/failover, the master discovering how
>   many relays to push to, count aggregation across relays, and the extra hop's latency on the
>   clock. Don't build these blind.
- [ ] **D3. Late-join snapshot path:** full current-state snapshot to reconstruct
      *now* — incl. the auto-mix queue (distinct from the steady event stream). The
      existing `state` snapshot + per-guest queue stream is the seed of this.
- [ ] **D4. Clock sync:** NTP-style offset/RTT estimation per client + resync cadence.
- [ ] **D5. Engine-version pinning per room** + "client too old to join" handling.
- [ ] **D6. Resync contract for non-deterministic gestures** (scratch/jog → snap
      to next downbeat/cue via the beatgrid).
- [ ] **D7. Per-listener track-availability divergence** (geo-block) detection +
      graceful fallback.
- [ ] **D8. Local catch-up policy** for drifting listeners (skip-to-live vs slow-pull).
- [ ] **D9. Single-flight cold-decode dedup** at the edge (thundering-herd guard).
- [ ] **D10. Reconnect storm handling:** backoff + jitter, fast snapshot rehydrate.

## E. Rooms as first-class objects + lifecycle + seat UX  *(P2, critical path)*

> **Directory spine DONE 2026-06-16 (data + API, build-green, uncommitted).** The
> DjRoom DO has no D1 binding, so the **host client announces** its live room to a D1
> shadow that the public directory queries. Files: `0014_rooms.sql` (per-host `rooms`
> row), `db.ts` (`announceRoom`/`closeRoom`/`liveRooms` + `ensureRoomsTable`),
> `accounts.ts` (`GET /api/rooms/live` public; `POST /api/rooms/{announce,close}` host,
> handle-gated), dev parity, client `fetchLiveRooms`/`announceRoom`/`closeRoom`.
> **UI SHIPPED 2026-06-16 (FX agent done).** `useRoom` exposes `goPublic`/`roomPublic`/
> `listenerCount` + an announce **heartbeat** (~30s while live). `SocialScreen` gained a
> host **"● Go live"** control (handle-gated; shows "Live at @handle · N listening") and
> a **"● Live now" directory** (polls `fetchLiveRooms`, busiest-first, taps through to
> `/@handle`). tsc 0, 38 tests, build green.
>
> **LISTENER TUNE-IN (Phase 2) SHIPPED 2026-06-16.** `useRoom.tuneIn(handle)`/`tuneOut()`/
> `listeningTo` **swap the socket** to the host's room in `listenHandle` mode (anon-capable)
> and derive the read-only listener role locally (a `pub` listener isn't in the roster →
> `joined`/`listening` forced true, never controlling/host/anchor). The existing
> guest-reconstruction handlers render the mix. `SocialScreen`: a **Live-now row taps to
> tune in** (unlocks audio via `onActivate`), a **"🎧 Listening to @X · Stop"** banner,
> own-session footer hidden while listening. **STEMS-FROM-R2 already covered** (corrected
> 2026-06-16): a `pub` listener IS a follower (`followRef`/`snapFollowRef` true), so the
> existing follower-stem path fires — incl. the mobile **R2 download of the host's cached
> neural set** (`App.tsx:1174` `PROMOTE_ORDER` probe), lazily materialized on stem
> divergence (the iPhone-OOM design). **Desktop is covered too:** model="off" hits the
> `autoEnhance` path (default ON, `App.tsx:1108`) → `promoteCachedStems` probes the shared
> R2 cache (`1022-1059`) → downloads the host's set. So mobile + desktop both pull the
> host's stems from R2 by default, just gated differently (mobile: forced for followers;
> desktop: auto-enhance). Only non-stem case = a desktop user who EXPLICITLY disabled
> auto-enhance (a deliberate "stay on my model" opt-out — correct, not a bug). No fix
> needed. Also fixed `refreshUser()` (Profile-close
> → "Go live" un-gates post-claim, no reload) + the `DEV_LOGIN` shortcut login.
> **Still next:** now-playing in the heartbeat, a "Listen" button on `/@handle` itself,
> stems-from-R2; E3–E10/E12 (per-deck roles, seat UX, gate modes).
>
> **SEAT/STAGE UX SHIPPED 2026-06-16 (E3/E4/E6a + the per-deck gate, build-green).** The
> floor→stage transition is now real: a tuned-in broadcast listener taps **"✋ Request the
> decks" → Deck A/B**; the host sees **"✋ Wants to play"** in the roster and **Brings them
> up** onto that deck (or overrides A/B) or **Declines**. On approval the listener's socket
> is promoted in place (`pub` → roster participant: `joined+listening+controlling`, `decks`
> = the one deck, `stage:true`) — out of the anonymous crowd, into the roster, driving. They
> **Step down** back to the floor (reverts to a `pub` listener, never disconnected); the host
> can **⬇ floor** them too. **Per-deck enforcement is the spine:** the hot `intent` case now
> gates on `canDriveIntent(decks, intent)` (pure, unit-tested) — host/granted hold `"AB"`
> (drive everything, byte-for-byte as before), a stepped-up listener holds one deck and a
> deck-less move (crossfader/automix/queue) needs full control. Stage devices **never anchor**
> (`settle`/`nextAnchor` exclude them — the broadcast origin keeps the clock). Ending the
> broadcast drops stage DJs with the crowd. Files: `protocol.ts` (`StageReq`, `stage`/
> `stage-approve`/`stage-deny` + `stage-self` decline signal, `Peer.decks`/`stage`,
> `canDriveIntent`), `client.ts`/`useRoom.ts` (`requestStage`/`stepDown`/`approveStage`/
> `denyStage` + role-derivation trusts the roster row once promoted), `room.ts` (the three
> cases + `canDrive`/`isStage`/`returnToFloor`/`stageReqs` + presence surfacing to
> participants only), `SocialScreen.tsx` + `styles.css` (`StageBar` + host request list +
> stage card). **All over the EXISTING public socket — no Worker/migration change.**
> **Follow-up DONE `d0d63fa`:** the client-side per-deck LOCK (off-deck dim + control gate,
> zoom/expand kept live) — E4's "deck UI locked/dimmed off your seat" is now shipped, closing
> the local-desync gap (a stage DJ can no longer even touch their off-deck). E6 gate modes
> (open/request/invite) + E6a's knock-to-listen for PRIVATE rooms still open.

- [~] **E1. Room object model** — registry/data layer done (per-host live `rooms`
      row + heartbeat). Addressing already decoupled via D-1 (`?room=@handle` →
      `home:${accountId}`). *(Persistent venue history/schedule = later.)*
- [~] **E2. Public room directory** — `GET /api/rooms/live` (busiest-first, freshness-
      filtered) + `fetchLiveRooms()` shipped. *(The "live now" screen UI is deferred.)*
- [~] **E3. Role ladder:** host → co-controller (full grant, existing) → **stepped-up
      listener (one deck, `stage`)** → listener → floor. **Per-deck claim landed** as the
      `decks` permission + `canDriveIntent` gate (a stage DJ drives exactly their deck).
      *(b2b handoff / co-controller deck-split UI = later.)*
- [x] **E4. Seat/stage UX:** floor ⇄ decks transition shipped — "✋ Request the decks /
      Step down" on the listener, "Bring up / ⬇ floor" on the host. **Per-deck on-screen LOCK
      done** (`d0d63fa`): a deck the device can't drive (a stage DJ's OTHER deck; both for a
      pure follower) goes non-interactive + dimmed (button bank + crossfader `pointer-events:
      none`, waveform jog/seek/bend gated in DeckLane) — but **zoom + expand stay live** so a
      listener can still inspect either waveform. Keyboard/MIDI gate per-deck via
      `canDriveDeckRef`. *(b2b deck-split co-controller UI still later — E3.)*
- [ ] **E5. Demote the two old toggles:** mute → trivial player mute (not a mode);
      device-output routing → multi-device-only setting that defaults correctly.
- [~] **E6. Gate modes:** the **request-to-play** path is live (raise-hand → host
      approve/decline + per-listener state feedback: request → pending → up/declined).
      *(Still open: an `open decks` mode that skips host approval, and `invite-only`; both
      are a host flag on top of the shipped handshake.)*
- [x] **E6a. Listen default already inverted for public rooms.** A `pub` listener tunes in
      open (no knock) and only *taking the decks* raises a hand (the `stage` request) — the
      private knock-to-listen path is untouched (still the invite-room model).
- [ ] **E7. Host-disconnect grace window** + rehydrate; optional host handoff.
- [ ] **E8. DO-eviction rehydration** of room state (now-playing, roster, gate mode).
- [ ] **E9. Co-controller disconnect mid-control** (deck freeze vs auto-release).
- [ ] **E10. Max room-size cap** + at-cap failure mode (decision in Open Decisions).
- [~] **E11. Zombie/orphan cleanup** — directory freshness filter (`last_seen > now-90s`)
      ages out a vanished host now; physical row sweep = later (lazy).
- [ ] **E12. Private→public room transition** permission model.

## F. Crowd → DJ interactivity channel  *(P3)*

- [ ] **F1. Song requests:** crowd feeds a queue the DJ can pull from (maps onto
      the library/match engine). Anti-flood rate limit per listener.
- [ ] **F2. Live hype/energy meter:** aggregate reactions into a signal the DJ sees.
- [ ] **F3. Vote-the-next-track** / crowd setlists.
- [ ] **F4. Reactions:** server-side aggregation + rate limit; NEVER fan out each emoji.
- [ ] **F5. Chat at scale:** slow-mode, follower-only option, rate limit, mention
      controls (`@everyone` guard), moderation hooks.

## G. Async layer (persistent surface when nothing's live)  *(P4)*

- [ ] **G1. Recorded sets** as first-class objects — record the recipe stream,
      replay deterministically. Cheap; respects D5 engine-version pinning.
- [ ] **G2. Auto-generated tracklists** (from track metadata + play history) as
      the shareable set artifact.
- [ ] **G3. Clips / moments:** capture a drop/transition.
- [ ] **G4. External shareability:** share links, OG cards, embeds (the viral loop
      — how htl content escapes htl).
- [ ] **G5. Recording lifecycle:** ownership (host? co-DJs?), R2 storage,
      retention, deletion, replay-with-version-skew handling.

## I. Notifications  *(P5)*

- [ ] **I1. Event types:** go-live, new follower, mention, request-accepted, invited-up.
- [ ] **I2. Fan-out strategy** (write vs read) — celebrity go-live = 100k pushes.
- [ ] **I3. Batching + dedup + quiet hours + per-type prefs.**
- [ ] **I4. Delivery channels** (in-app; web push later).

## J. Discovery & cold-start  *(P4)*

- [ ] **J1. "Live now from people you follow" feed** (fan-out decision in Open Decisions).
- [ ] **J2. Directory ranking** (trending, listeners, genre) + anti-gaming signals.
- [ ] **J3. Cold-start fallback:** community pool as always-on "something's
      playing" when no rooms are live; seeded/scheduled rooms.
- [ ] **J4. Empty-state design** for zero-live-rooms (first impression).

## K. Presence & status  *(P5)*

- [ ] **K1. Status semantics:** online / live / listening-to-X.
- [ ] **K2. Accurate presence count:** heartbeats + stale-connection reaping (a
      socket ≠ a listener — backgrounded/muted/dead).
- [ ] **K3. Invisible/ghost mode + DND.**
- [ ] **K4. Privacy of "currently in room X" / "listening to Y"** (broadcast or not).

## L. Moderation & safety  *(P5)*

- [ ] **L1. Host/mod roles:** kick / ban / mute within a room.
- [ ] **L2. Report flow → existing admin worker** (moderation queue / DMCA muscle).
- [ ] **L3. Handle + chat blocklists** (reuse A5 lists).
- [ ] **L4. Anti-sybil:** fake-listener count inflation, follow bots corrupting J2.
- [ ] **L5. Social-action rate limits** (follow/mention/request spam) — extend the
      existing `allow()` / rate-limit bindings from the security hardening pass.

## M. Privacy & data lifecycle  *(P5)*

- [ ] **M1. Public-vs-private field matrix** (handle/display/avatar/bio public;
      email/connections/legal name private).
- [ ] **M2. Discoverability opt-in** (mirror of C5).
- [ ] **M3. Account-deletion cascade:** sessions, follows (both directions), owned
      rooms, recordings, chat, mentions; handle tombstone (A10).

## N. Mobile & cross-device  *(P5)*

- [ ] **N1. Verify the mobile listener path:** local reconstruction needs no neural
      separation (`canSeparate` stays off) — confirm plain playback/stretch path,
      watch battery/data.
- [ ] **N2. Listener handoff** phone ↔ laptop.
- [ ] **N3. Backgrounded-tab / locked-phone** audio continuation + presence accuracy.

## O. ToS & policy  *(cross-cutting, with P2 launch)*

- [ ] **O1. ToS update:** host is liable for broadcast content; user responsible
      for their library (same posture as today, extended to public broadcast).
- [ ] **O2. Public-room content rules surfaced at room creation** (acknowledgement).
