# Social Layer — Project Plan

> ⚠ **Written as a project PLAN; the epics in it are live (2026-09-01).** Read the
> ★ CURRENT STATE block before the roadmap prose, and treat future-tense wording
> as historical.

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

## Surface architecture (UI) — 3 surfaces + the set lifecycle

> **Settled 2026-06-17.** The "Session" right-dock panel had grown to ~12 stacked
> jobs (discovery + room setup + crowd channel + roster/mod) and was the dumping
> ground every new social feature landed in. The fix is **not tabs inside Session** —
> it's recognizing there are **two axes plus a bridge**, and giving each its own surface
> so future epics (G sets, J feed, I notifications) have an obvious home that is NOT
> the room panel.

**Two axes:**
- **PERSON** (persistent, account-scoped) — handle/profile/bio, the follow graph,
  top songs, recorded sets, live status. A profile is an *account*.
- **ROOM** (ephemeral, device-scoped) — the live session: roster, crowd channel,
  seat/stage UX, share/go-live/gate. A roster row is a *device*, never linked to an
  account id (`ProfileScreen.tsx` design note) — that's why person ≠ room object.

**Three surfaces:**

| Surface | What it is | Live/Set role |
|---------|-----------|---------------|
| **① Discover** | The browse-what's-out-there experience, its OWN surface (not part of a profile, not part of the room). Two facets of one browse UX: **Live now** (sessions happening now) + **Sets** (newly-published / popular recordings). | The *list* — rooms/sets you don't know yet |
| **② Profile** (own + `/@handle`) | The person. **Tabbed: Public display \| Configuration.** Public tab = identity/bio/top-songs/**sets history**/follow-counts + a **live badge & "● Listen live"** when on the decks (already wired, `PublicProfileScreen.tsx:91`); this tab IS the `/@handle` render (own + public share one component). Config tab = the account plumbing (connections/OAuth, handle claim/rename, edit display+bio, privacy, sign-out). | A *badge* — is THIS person live; their set *history* |
| **③ Session** | Shrinks to just the room you're in/hosting: setup/share/go-live/gate, roster, seat UX, crowd channel (hype/chat/requests/reactions), **+ recording controls** (see lifecycle). `LiveNow` moves OUT to Discover. | The room you're *currently in*; the tape being recorded |

**One signal, three reads:** Discover lists who's live, Profile badges whether *this*
handle is live, Session *is* one live entry — all off the same `liveRooms` signal.
Sets parallel it exactly: Discover ranks published sets, Profile shows *this person's*
history. **Every "enter a session" routes through `tuneIn(handle)`** regardless of entry
point (Discover row / profile Listen-live / shared link); every "watch a set" through one
replay path.

**The live → recorded → published lifecycle (the Session↔Sets seam):**

```
LIVE ──(auto-buffer the digest)──▶ ENDED ──▶ DRAFT ──(publish)──▶ PUBLISHED
                                     │         (private,           (public:
                                     └─discard  Profile history)    Profile + Discover)
```

- **A recording IS the broadcast digest, persisted.** Not a new capture system —
  the broadcast plane already publishes the recipe stream (clock + deck params +
  now-playing) to listeners; G1 tees that exact stream to R2/D1. A live broadcast is
  a recording-in-flight; *save* = keep the tape. Replay = play the timestamped log
  back into the same handlers a live listener uses.
- **Commands-only, re-rendered on device.** Stored = track *references* (source IDs)
  + transport + deck params/intents/cue/loop/fx/stem events. **No audio.** Replay
  resolves each track ID → fetch/decode source PCM via the edge proxy → run the
  bit-exact engine → apply recorded commands at recorded timestamps → identical mix.
  This is **also the right legal posture** (same ToS lane as live: host's device
  re-fetches from source; we never store/redistribute audio → no DMCA/licensing drag).
- **Capture-by-default, curate-after** (decided over explicit opt-in): recipes are
  tiny, the "wish I'd recorded that" problem is real, and privacy is fully handled by
  *private-draft-until-publish*. Retention: keep-all (cheap); DVR-style auto-expire of
  unpublished drafts only if it nags.
- **Replay fidelity caveats (why D5→D6 gate G):** "re-renders identically" holds GIVEN
  same source decode + **pinned engine version (D5)** + auto-derived values
  (detected beatgrid/key a `sync`/`key` leaned on) reproducing or **baked into the
  recipe (D6)**. A dead/geo-blocked source ID = a graceful gap, not a crash. Stems
  follow the live R2-cache-only model (fallback to full-track).
- **Surface mapping:** Session owns the **record toggle + post-set Save/Publish/Discard
  card**; Profile owns **sets history** (drafts+published); Discover owns **published
  browse**. Co-DJ/stage-guest sets → **host-owns, co-DJs credited** (default, G5).

**Build order:** the Discover/Profile restructure is independent of G and lands FIRST
(decongests Session immediately — mostly relocating already-modular leaves + the Profile
tab split, where the public tab reuses the `/@handle` render). The Sets facets then slot
into the already-defined Discover-ranking + Profile-history holes when **G1** lands
(which D5→D6 gate). Affected epics annotated below: **B3** (live badge — substantially
shipped), **E2/J1** (Discover surface), **G1–G5** (sets), **B5** (profile sets history).

## Ordered backlog (task list — 2026-06-18)

The remaining work, ordered. Top of the list is the active push; per-task detail is in the
Epics section below. **Done so far (2026-06-18, main, shipped):** surface restructure
(Discover surface + public-first Profile), **B3**, **J1** (v1), **D5**.

### Tier 1 — Sets spine (Epic G) — the active push
- [x] **G1a — capture + model.** DONE (`18b32f0`, shipped). `SetCapture` (src/htl/room/
      setCapture.ts) tees the host's outbound recipe (snapshot+intents+automix+~1/sec ticks;
      drops display-only stemview/lyrics) → on broadcast-end POSTs to `POST /api/sets` → R2 log
      blob `sets/<id>.json` + a `sets` D1 row (migration 0016, server/db/sets.ts) as a private
      DRAFT. `GET /api/me/sets` (own history), `GET /api/sets/:id` (card; `?log=1` → R2 recipe for
      replay). engineVersion stamped (D5). Host-side for v1 (recipe is cheap, dodges the DO
      write-quota ceiling — [[htl-do-write-quota]]); solo host = full capture (co-DJ intents not
      tee'd here — G5). 86 tests green. **Migration 0016 needs `d1 migrations apply` at deploy.**
- [x] **G1b — lifecycle.** DONE (`3dce9d6`, shipped). `RecordingsPanel` in Session lists the
      host's sets (fetchMySets) → Publish / Unpublish / inline Rename / Discard (deletes row +
      R2 blob). Owner-only routes `POST /api/sets/:id/{publish,unpublish,rename}` + `DELETE
      /api/sets/:id` (403 unauthed, drafts 404 to non-owners). Self-hides until the first set,
      stays collapsed (Session stays uncluttered), auto-opens when a fresh draft lands via the
      new `room.setsRev` signal. Verified end-to-end against the live worker (2 drafts captured).
- [x] **G1c — replay** DONE (`e99fd0c`, shipped). `useSetReplay`
      (src/htl/replay/) drives a local rAF clock that fires each recipe entry at its timestamp
      through the SAME live-listener handlers (App `replayDispatch` → applyRoomSnapshot/onRoomIntent/
      onRoomTick/setRemoteAutomix; follow gates forced open while replay.active). play/pause (halts
      decks)/seek (rebuild from last snapshot + intents + final tick)/stop. ReplayBar transport;
      ▶ Play on each set in Profile "Your sets" (gated off while in a live session). D5 mismatch
      warns; dead source id = graceful gap (load self-heals). *Decks play own clock at 1x, ticks
      correct drift — the broadcast-listener contract.*
- [x] **G1d — surfaces.** DONE (`4f288ec`). Discover "Sets" facet + public /@handle "Sets"
      section, both tap-to-replay (G1c). `discoverSets` host-identity join; `GET /api/sets/discover`
      + `GET /api/u/:handle/sets`; reusable `SetList` card; one `playRecordedSet` in App. **The Sets
      spine G1a→d is COMPLETE** (capture → lifecycle → replay → surfaces).
- [ ] **D6 — gesture resync contract.** scratch/jog → snap to grid so non-deterministic gestures
      bake cleanly into the recipe. *Fidelity follow-up to G1c, not a blocker.*
- [x] **G2** tracklists (expandable set cards) · **G3** clips/moments (`/set/:id?t=` range deep-links,
      ReplayBar ⚑ + play-this-moment CTA) · **G4** share links + OG cards (worker-injected, verified) ·
      [x] **G5** lifecycle substantially done (deletion/version-skew(D5)/R2/host-ownership shipped;
      co-DJ credit moot until co-DJ capture; retention=keep-all). **Sets spine G1-G5 COMPLETE.**

### Tier 2 — cheap / unblocked polish
- [x] **F1→queue** DONE (one-tap ＋Queue on a host request → searchYouTube → queueEdit.add → dismiss)
- [x] **F2** DONE (HypeHud in the chin when broadcasting/listening; throbs hot, taps to crowd)
- [~] **E5** DEFERRED — "mute" is the per-device `listening` flag (role model: joined/listening/
      controlling); output-routing is ALREADY a SettingsPanel setting. Demoting `listening` risks the
      seat model replay/sync/broadcast depend on, for low gain. Revisit only if the toggle confuses users.
- [x] **B5** DONE via G1d ("Your sets" on own Profile + published on /@handle).

### Tier 3 — room robustness (E + D hardening)
- [x] **E7**/**E8** done+validated (see Tier-1/E detail). **E9** covered by design — deck-held/
      controller state derives from LIVE sockets, so a dropped stage-DJ/co-controller AUTO-releases
      their deck (recompute excludes the closed socket). **E10** cap + accept-then-kick "room full"
      (4003) + no-reconnect-into-terminal-closes (`5d…`), which also kills the broadcast-end storm.
- [~] **D3** late-join snapshot COVERED (sendCatchUp ships snapshot+automix+stemview+lyrics; relay
      caches the same). **D10** reconnect backoff+JITTER done (client.scheduleReconnect) + terminal-
      close guard. DEFERRED (demand-gated / speculative, low current value): **D4** NTP clock sync,
      **D7** geo-block divergence, **D8** drift catch-up policy, **D9** cold-decode single-flight
      (needs a DecodeLock DO — build with the load harness when broadcast cold-loads bite, like D2).

### Tier 4 — scale (demand-gated — MEASURED: one DO holds 500, see D2 spec note)
- [x] **D2** relay tier VALIDATED PoC (`2d0a954`). RelayRoom crowd shards, env-gated (RELAY_SHARDS,
      default off). Load-validated N=1000/R=4 → p95 48ms (vs single-DO p95 910ms @ N=500). TODOs:
      relay failover/liveness + crowd→DJ forwarding from sharded listeners (receive-only in PoC). · **C4** denormalize follower counts

### Tier 5 — moderation leftovers (Epic L)
- [ ] **L4** anti-sybil (listener-count inflation, follow bots) · follower-only chat (needs the
      graph at the DO) · @everyone mention guard · **L1** co-host mod-grant · **L5** HTTP
      follow/mention rate limits

### Tier 6 — cross-cutting (P5)
- [ ] **I** notifications (go-live / follower / mention / invited-up; fan-out strategy) · **K**
      presence semantics (online/live/listening, accurate counts, ghost/DND) · **M** privacy
      matrix + **M3** account-deletion cascade (unblocks **A10** handle tombstone) · **N** mobile
      listener path (verify/handoff/backgrounded audio) · **O** ToS for public broadcast

---

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
- [x] **A2. Login-stomp bug fixed.** `upsertGoogleUser` (`server/db.ts`) now writes only
      `email`/`name`/`avatar`/`last_login` (the Google mirror) — never the user-owned
      `display_name`/`avatar_url`/`bio`. Confirmed in code 2026-06-16.
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
- [x] **B3. Live status on profile** — DONE. Visitor side: "● Listen live · N tuned in" on
      `/@handle` (PublicProfileScreen). Own side: a pulsing "● Live now · N listening" badge on
      the Profile hero (taps through to the Session dock), fed by `room.roomPublic`/`listenerCount`.
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
> **MEASURED 2026-06-19 (scripts/loadtest-room.mjs — a real harness: dev-auth host goes public +
> emits timestamped ticks, N synthetic pub-listeners measure admit/latency/count).** The single
> DjRoom holds up FAR better than the pessimistic "~hundreds": N=200 → full delivery, fan-out
> p50 8ms / p95 24ms, count accurate; N=500 (the MAX_LISTENERS cap) → still full + accurate but
> the TAIL degrades (p50 17ms / **p95 ~910ms / max ~2.1s**) as the single-thread O(N) send loop
> serializes ~2500 sends/s. **Conclusion: one DO is fine to ~500 (the cap is at the knee); the
> relay tier is genuinely only needed for >500 (thousands).** The harness is now the validation
> rig — build the relay against it (push past 500 across R shards, watch the p95) the moment a
> room demands it. Not before.
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
- [x] **D5. Engine-version pinning per room** — DONE. `ENGINE_VERSION` (protocol.ts) is the
      single reconstruction-engine version; client reports it on connect (`?ev=`), the room stamps
      the ANCHOR's into `welcome`/`presence` (`engineVersion`), the client self-detects a mismatch
      (`engineStale`) → tap-to-reload notice. G1 stamps the same constant on recordings for
      pin/refuse replay. *(BUMP ENGINE_VERSION on any reconstruction-affecting change.)*
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
- [x] **E6. Gate modes DONE.** A host-set `stageGate` on the public lobby: **request**
      (raise-hand → host approves; default), **open** (grab any FREE deck instantly, no
      approval — `deckHeldByStage` blocks a second grabber on the same deck), **closed**
      (the crowd can't step up; host + private invitees only). Persisted, rides welcome +
      presence (both full & lite) so every listener's StageBar shows the right affordance
      ("Take A/B" vs "Request" vs "🔒 closed"). Host picks it from a segmented control in the
      Public-lobby card. Refusals send `stage-self` (clear pending) + `error` (the reason).
- [x] **E6a. Listen default already inverted for public rooms.** A `pub` listener tunes in
      open (no knock) and only *taking the decks* raises a hand (the `stage` request) — the
      private knock-to-listen path is untouched (still the invite-room model).
- [x] **E7. Host-disconnect grace DONE+VALIDATED** (`scripts/test-host-drop.mjs`: 20/20 released
      at ~8077ms). 8s anchor grace (host reconnect resumes seamlessly); grace-expiry on an abandoned
      PUBLIC room now `endBroadcast("The host left.")` instead of freezing the crowd. Handoff to a
      participant for private rooms via nextAnchor.
- [x] **E8. DO-eviction rehydration COVERED** — `load()` runs atop every entry point (fetch/
      webSocketMessage/webSocketClose/grace), so a hibernation wake rehydrates anchor/snapshot/
      public/gate/grants/mutes/stemviews/lyrics before handling; roster = platform-restored
      hibernated sockets. Only ephemeral crowd state (reactions/hype/requests) intentionally not
      persisted (transient; dodges the DO write-quota).
- [ ] **E9. Co-controller disconnect mid-control** (deck freeze vs auto-release).
- [ ] **E10. Max room-size cap** + at-cap failure mode (decision in Open Decisions).
- [~] **E11. Zombie/orphan cleanup** — directory freshness filter (`last_seen > now-90s`)
      ages out a vanished host now; physical row sweep = later (lazy).
- [x] **E12. Private→public transition** — host-only `public` toggle (un-forgeable; the DO
      gates on `isHostDevice`); existing private guests are unaffected by the flip (they're
      roster participants, not `pub`); ending the broadcast evicts the anon crowd + any stage
      DJs they brought up. Deck access for the crowd is then governed by E6's `stageGate`.

## F. Crowd → DJ interactivity channel  *(P3)*

- [x] **F1. Song requests DONE (free-text v1).** Listeners type a request; the DO holds an
      in-memory list (capped `MAX_REQUESTS`, deduped, one-per-device-per-`REQUEST_RATE_MS`) and
      pushes it to PARTICIPANTS only (`relayRequests`) — the crowd feeds it, the DJ reads it.
      Listener form in the CrowdPanel ("Request a song…"); host list in the body with dismiss +
      Clear all. *(Follow-up: a one-tap "→ queue" that maps the text onto a catalog search +
      the first-class auto-mix queue, instead of the DJ pulling it by hand.)*
- [x] **F2. Live hype/energy meter DONE.** The DO keeps a decaying 0..1 `hype` EMA (per-flush
      decay + window-total gain), flushed with the reaction frame; the SocialScreen renders it
      as a filling bar (throbs when hot) + a floating-emoji burst. The flush keeps ticking to
      decay hype even with no new taps, then idles.
- [x] **F3. Vote-the-next-track DONE (as upvoting the requests).** The F1 request pool IS the
      crowd-ranked setlist: each request carries `votes` (the asker auto-votes → ≥1), listeners
      tap ▲ to upvote (idempotent — one per device per request, voter sets tracked in the
      `Requests` unit), and the DO re-ranks + relays the list to EVERYONE (the crowd needs it to
      vote, so requests are no longer participant-only). Shared `RequestList` component: crowd
      variant = ▲ + track; host variant adds who-asked + dismiss + clear. The DJ pulls from the
      top. *(Deferred alternatives: DJ-proposed polls, voting on the auto-mix queue.)*
- [x] **F4. Reactions DONE.** Fixed emoji set (`REACTIONS`, validated by `isReaction`); the DO
      AGGREGATES taps in a window and flushes ONE frame per `REACT_FLUSH_MS` (~1 Hz) to everyone
      — never per tap — with a per-device token bucket (`REACT_RATE_MAX`/window) capping a
      spammer. Pub listeners may `react` (guard carve-out). `react-bar` in SocialScreen; shown
      wherever a broadcast is happening (you host one or you've tuned in).
- [x] **F5. Chat DONE.** A `Chat` unit (roomCrowd.ts) buffers a rolling backlog (last 30, sent
      on join) + enforces an always-on 1s anti-spam floor under the host's **slow-mode** (Off /
      On / 5s / 15s, persisted, rides presence). Lines fan out to everyone; `ChatPanel` is shown
      in any session or broadcast. *(Deferred: follower-only — needs the follow graph at the DO,
      which it can't see yet; `@everyone` mention guard.)*

## G. Async layer (persistent surface when nothing's live)  *(P4)*

> **Surfaces decided 2026-06-17** — see "Surface architecture (UI)" above. Sets are
> the **persistent twin of live**: a recording = the broadcast digest persisted
> (commands-only, re-rendered on device at replay), captured-by-default as a private
> draft, published to Profile-history + Discover. Session owns record + Save/Publish/
> Discard; Profile owns history (B5); Discover owns the published browse. D5→D6 gate
> deterministic replay.

- [ ] **G1. Recorded sets** as first-class objects — tee the broadcast digest to R2/D1,
      replay deterministically (commands-only; device re-renders from source). Cheap;
      respects D5 engine-version pinning + D6 baked-gesture contract.
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

- [~] **J1. "Live now from people you follow" feed** — v1 DONE in Discover: rooms hosted by
      handles you follow surface in a "From people you follow" section above "Also live now"
      (client splits the live-rooms signal against `/api/following`; on-read, no fan-out yet).
      *(A dedicated follows-only feed / push fan-out = later.)*
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

- [~] **L1. Host/mod roles:** kick (guests, existing) + **mute** (per-device chat block, from a
      chat message) + **ban** (evict + session re-entry block via a `banned` device set) DONE for
      chat moderation. *(Room-wide ban persistence + a mod-role grant to co-hosts = later.)*
- [x] **L2. Report flow → admin worker DONE.** End-to-end: `POST /api/report` (anon-ok,
      ≤20/reporter/hr) → `reports` D1 table (migration `0015`, `server/db/reports.ts`) → the
      admin worker's `GET /api/reports` + `POST /api/report/resolve` + a **Reports** tab in the
      admin page (resolve from the moderation queue). Client `fileReport` + a ⚑ report button on
      others' chat lines (the host moderates directly instead). Migration `0015` applies at deploy.
- [~] **L3. Handle + chat blocklists.** Handle side via A5 (`RESERVED_HANDLES`). **Chat side DONE:**
      `cleanChat` (security.ts) masks a `CHAT_BLOCKLIST` of severe slurs — whole-token match with
      leetspeak fold + plural, Scunthorpe-safe (grape/therapy untouched), applied in the `Chat`
      unit so every line is filtered. *(Multi-char-spacing evasion + a fuller list = later.)*
- [ ] **L4. Anti-sybil:** fake-listener count inflation, follow bots corrupting J2.
- [~] **L5. Social-action rate limits** — the in-DO crowd channels are all rate-limited now
      (reactions token-bucket, requests 15s, chat 1s floor + host slow-mode). *(Follow/mention
      HTTP-side limits via the `allow()` bindings still later.)*

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
