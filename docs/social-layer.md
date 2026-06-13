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

- [ ] **A1. Split user identity columns.** Add `display_name`, `avatar`
      (user-owned) distinct from `google_name`, `google_avatar` (mirrored).
- [ ] **A2. Fix the login-stomp bug.** `upsertUserFromGoogle` must update only
      `google_*` + `email` + `last_login`, NEVER the user-owned fields.
- [ ] **A3. `handles` table** (or `handle` + `handle_folded` columns) with a
      **DB-level UNIQUE on the folded form**. Treat insert-conflict as "taken"
      (don't app-check — TOCTOU race).
- [ ] **A4. Handle validation:** charset `[a-z0-9_]`, len 3–20, NFKC + lowercase
      fold for the uniqueness key, case-preserved for display.
- [ ] **A5. Reserved-handle seed list:** route names (`api`, `room`, `login`,
      `settings`, `admin`, `about`, `@`), impersonation targets (`official`,
      `support`, `staff`, `mod`, `htl`), profanity blocklist (+ leetspeak).
- [ ] **A6. URL shape decision + routing** (`/@handle`) and reserved enforcement.
- [ ] **A7. Claim-handle first-run flow** in `accounts.ts`: gate public features
      on having a handle; user can stay private without one.
- [ ] **A8. Backfill migration:** nullable handle + **system-assigned placeholder**
      (`user-ab12cd`) so existing rows are addressable. Do NOT derive from
      email/name.
- [ ] **A9. Rename policy:** rate-limit renames; old handle **cooldown/tombstone**
      (don't instantly free → impersonation). Store mentions/links by user `id`,
      render current handle.
- [ ] **A10. Recycle policy on deletion:** tombstone (don't recycle) or long
      quarantine. (See M3 deletion cascade.)
- [ ] **A11. Multi-provider future-proofing:** handle on account, not provider;
      document the account-link path for future "Sign in with X".

## B. Public profile surface  *(P1)*

- [ ] **B1. Separate "Account/Settings" (private) from "Public profile".** The
      current Profile modal is settings — email, connections, Disconnect stay
      private behind the owner-only eye toggle.
- [ ] **B2. Public profile object:** handle, display name, avatar, bio.
- [ ] **B3. Live status on profile** ("on the decks now → join").
- [ ] **B4. Top songs** (reuse existing play counts) as the taste surface.
- [ ] **B5. Past sets / venues hosted** list (depends on G).
- [ ] **B6. Followers / following counts + lists** (depends on C).
- [ ] **B7. Never fall back to email or Google legal name** for any public field.

## C. Social graph  *(P1)*

- [ ] **C1. Follow model** (asymmetric). Primitive that powers feed + go-live pings.
- [ ] **C2. Friends** (mutual/accepted) as a second tier for private-session access.
- [ ] **C3. Negative graph: block / mute.** Define enforcement (blocked user in
      your public room? in the count? block == room ban?).
- [ ] **C4. Celebrity hot-row handling** for follower lists (the 100k-follower DJ).
- [ ] **C5. Discoverability opt-in:** lookup-by-handle always; by-email /
      Spotify-graph matching is opt-in only.

## D. Broadcast plane & deterministic reconstruction  *(P2, critical path)*

- [ ] **D1. Broadcast digest protocol:** control room publishes now-playing,
      transport clock, deck/crossfader/EQ snapshot, cue events, presence, reactions.
- [ ] **D2. Relay tier:** master publishes once → relay DOs fan out to listener
      shards. Design now even if one relay runs at first.
- [ ] **D3. Late-join snapshot path:** full current-state snapshot to reconstruct
      *now* (distinct from the steady event stream).
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

- [ ] **E1. Room object model:** persistent **venue** (identity, host, followers,
      schedule, history) vs ephemeral **live instance** (roster, count, chat).
- [ ] **E2. Public room directory** ("live now," sorted by listeners / follows / genre).
- [ ] **E3. Role ladder:** host → co-controller (write, small N) → listener (large
      N) → b2b/handoff. **Per-deck claim**, not per-room control.
- [ ] **E4. Seat/stage UX:** floor ⇄ decks as the ONE prominent control; deck UI
      locked/dimmed on the floor; "Step up / Step down" is the transition.
- [ ] **E5. Demote the two old toggles:** mute → trivial player mute (not a mode);
      device-output routing → multi-device-only setting that defaults correctly.
- [ ] **E6. Gate modes:** `open decks` / `request-to-play` (default public) /
      `invite-only`, with **raise-hand queue** + host approve UI + state feedback
      (taken / gated / pending / invited-up).
- [ ] **E7. Host-disconnect grace window** + rehydrate; optional host handoff.
- [ ] **E8. DO-eviction rehydration** of room state (now-playing, roster, gate mode).
- [ ] **E9. Co-controller disconnect mid-control** (deck freeze vs auto-release).
- [ ] **E10. Max room-size cap** + at-cap failure mode (decision in Open Decisions).
- [ ] **E11. Zombie/orphan room cleanup** (vanished host, empty rooms in directory).
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
