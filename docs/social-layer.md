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

- [ ] **D1. Broadcast digest protocol:** control room publishes now-playing,
      transport clock, deck/crossfader/EQ snapshot, cue events, presence, reactions,
      **+ the host-authoritative auto-mix queue** (already streamed via `automix`/
      `queue` msgs — fold into the digest rather than a separate channel).
- [ ] **D2. Relay tier:** master publishes once → relay DOs fan out to listener
      shards. Design now even if one relay runs at first.
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
> own-session footer hidden while listening. **Non-stem mixes reconstruct now; stem mixes
> still need stems-from-R2 (`Deck.ts`).** Also fixed `useRoom.refreshUser()` (Profile-close
> → "Go live" un-gates post-claim, no reload) + the `DEV_LOGIN` shortcut login.
> **Still next:** now-playing in the heartbeat, a "Listen" button on `/@handle` itself,
> stems-from-R2; E3–E10/E12 (per-deck roles, seat UX, gate modes).

- [~] **E1. Room object model** — registry/data layer done (per-host live `rooms`
      row + heartbeat). Addressing already decoupled via D-1 (`?room=@handle` →
      `home:${accountId}`). *(Persistent venue history/schedule = later.)*
- [~] **E2. Public room directory** — `GET /api/rooms/live` (busiest-first, freshness-
      filtered) + `fetchLiveRooms()` shipped. *(The "live now" screen UI is deferred.)*
- [ ] **E3. Role ladder:** host → co-controller (write, small N) → listener (large
      N) → b2b/handoff. **Per-deck claim**, not per-room control.
- [ ] **E4. Seat/stage UX:** floor ⇄ decks as the ONE prominent control; deck UI
      locked/dimmed on the floor; "Step up / Step down" is the transition.
- [ ] **E5. Demote the two old toggles:** mute → trivial player mute (not a mode);
      device-output routing → multi-device-only setting that defaults correctly.
- [ ] **E6. Gate modes:** `open decks` / `request-to-play` (default public) /
      `invite-only`, with **raise-hand queue** + host approve UI + state feedback
      (taken / gated / pending / invited-up). Generalizes the existing
      knock/approve/deny/kick handshake (`server/room.ts`).
- [ ] **E6a. Invert the listen default for public rooms.** Today every guest knocks
      before even *listening* (private-room model). Public rooms: listening is open
      (no knock); only *taking the decks* triggers the handshake. Keep the
      knock-to-listen path for private/invite-only rooms.
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
