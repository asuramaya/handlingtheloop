# Auto-mix — inventory, diagnosis, redesign

Status: **implemented**, 2026-09-05 (all nine steps in §4; see the closing note). Companion to [automix.md](./automix.md) (which
describes the machine as designed) — this is the audit that preceded the rework:
why AUTO felt lacklustre, and what was changed. §1–§3 describe the code **as it
was**, and are kept as the record of the diagnosis; §6 records what shipped.

The goal: **AUTO on = sit back and watch.** The deck picks the next record,
beatmatches it, and performs the transition using the controls a human would use.
At the time of the audit it did about a third of that.

---

## 1. Inventory — what exists

### 1.1 The selection path (what plays next)

```
history (last 3 played)
   │
   └─► queue.ensureNext()                       src/htl/automix/queue.ts:181
         ├─ fetchRecommendations(seed) ×3        src/htl/media/recommend.ts:17
         │     └─ GET /api/recommend?v=&provider=&isrc=&title=&artist=
         │           ├─ dev:  server/api.ts:438            → YouTube watch-next only
         │           └─ prod: worker/routes/catalog.ts:34  → Tidal radio ▸ YouTube watch-next
         │                 └─ recommendNext()              server/recommend.ts:32
         │                       └─ getWatchNext()         server/innertube.ts:407
         │                             └─ collectVideos → fromLockup / fromCompact
         ├─ aggregate relatedness across the 3 seed lists
         ├─ songCore() dedup                    src/htl/automix/mixability.ts:95
         ├─ fetchAnalysisBatch() enrichment (D1 cache only)
         └─ score = 0.6·rel + 0.4·avgMixability  queue.ts:252
```

Constants (`queue.ts:57`): `RADIO_MIN_AHEAD 4`, `FILL_COOLDOWN_MS 12_000`,
`MAX_APPEND 8`, `MAX_QUEUE 14`, `PLAYED_CAP 100`, `SEED_HISTORY 6` (only 3 used).

### 1.2 The performance path (how it mixes)

`AutoMixer` (`autoMixer.ts`, 1025 lines) — `idle → armed → preload → cueing →
mixing → settle`, plus `manual` when the user grabs the fader. Ticked at 150 ms
from `App.tsx:2740`.

Controls it **does** drive:

| Control | Where |
|---|---|
| crossfader | `tickMixing` linear ramp on wall-clock playing time |
| EQ3 low (bass swap) / high (outgoing duck) | `tickMixing:845` |
| one-knob filter (HP out / LP in) | `tickMixing:838,852` |
| stem gains (4-stem arrangement-aware swap) | `tickMixing:822` |
| SYNC + KEY lock | `startMix:705` |
| tempo glide (master ramps, slave follows) | `glideTempo:745` |
| keylock pin (vinyl-pitch blends) | `beginGlide:723` |
| mix-out / mix-in point selection | `computeMixOut:954`, `computeMixIn:989` |

Controls it **never touches**, all of which exist and are wired:

| Control | API |
|---|---|
| channel trim / level | `Deck.setTrim`, `Deck.setLevel` (`Deck.ts:1926`) |
| integrated loudness | `Deck.loudness` getter (`Deck.ts:2751`) — computed, unused by AUTO |
| loops / beat-loop / roll | `Deck.setBeatLoop`, `reloop`, `rollOut` (`Deck.ts:1895`) |
| hot cues | `Deck.hotCue` |
| beat-jump / phrase-jump | `Deck.beatJump:1845`, `phraseJump:1865` |
| FX rack (delay, reverb, gate, crush, …) | `FxRack` (`Fx.ts:14`) — 10 device kinds |
| spinback / brake | `Deck.spinback:1627` |
| section labels A/B/C/D | `Beatgrid.phraseLabels` (`analyze.ts:58`) |

### 1.3 Supporting pieces

- `mixability.ts` — Camelot distance + octave-folded BPM ratio → `pickTransition`.
- `usePrefetch.ts` — background decode/analyse of the next 3 queued tracks so key/BPM
  exist by mix time. Desktop only, 2 s gap, one at a time.
- `smartFader.ts` — the hand-driven twin of the same DSP.
- `MixQueuePanel.tsx` — the UI: seed dropdown, per-pair transition badge, Mix now / Skip / Hold.
- Tests: `autoMixer.machine.test.ts` (482 lines), `autoMixer.test.ts`, `mixability.test.ts`, `queue.test.ts`, `smartFader.test.ts`.

---

## 2. Diagnosis — why the suggestions are wrong and repetitive

### P1 — The vibe anchor is dead code (regression)

`AutoMixer` maintains `this.anchor` (the track the user last put on) and a carefully
guarded, exported, unit-tested `radioSeedSet()` (`autoMixer.ts:80`) that combines
live deck + anchor + other deck. Every caller computes it and passes it:

```ts
const seeds = this.radioSeeds();
const next = await this.deps.queue.ensureNext(seeds.length ? seeds : ...);
```

`ensureNext` then throws it away — the parameter is literally named `_legacySeeds`
and never read (`queue.ts:181`). Commit `f822b8e` moved seeding to play-history and
left the caller side intact.

**Consequence:** the "session vibe" tether described in the comments and in
`automix.md` has *no effect*. Suggestions are anchored only to the last three songs,
so a set drifts freely — three songs of drift and you are somewhere else entirely.
This is the single biggest "wrong suggestions" cause.

### P2 — The seed window is a repetition amplifier

Seeds are `history[0..2]` — the last three plays. After each song the window slides
by one, so **two of three seeds are unchanged**. The candidate pools overlap heavily,
and then the aggregation step *rewards the overlap*:

```ts
// queue.ts:221 — a track in MULTIPLE seeds' radios scores higher
if (ex) ex.rel += r; else rel.set(...)
```

So the ranking explicitly promotes the small set of tracks common to all three
radios — which, song after song, is the same set. That is the repetition, by design.

### P3 — The harmonic refinement is inert in practice

`score = 0.6·rel + 0.4·avgMixability`. But `avgMixability` returns the neutral `0.5`
whenever key or BPM is missing (`mixability.ts:45,51`), and fresh radio candidates
essentially never have analysis — `fetchAnalysisBatch` only returns what is already
in D1, and `usePrefetch` only analyses tracks *already in the queue*, i.e. after
ranking. So for most candidates the term is a constant and the ranking collapses to
`0.6·rel + 0.2` — **pure YouTube watch-next order**. The "provider backbone refined
by harmonics" is, in the common case, just the backbone.

### P4 — The queue's tail is destroyed every single song

`seedChanged` is true every time a track starts (the history head moved), which
bypasses the cooldown *and* replaces the tail:

```ts
// queue.ts:272
const merged = seedChanged ? [...pinned, ...ranked] : [...cur, ...ranked];
```

Every song: 3 recommend round-trips + 1 analysis batch, the visible "up next" list is
thrown away and rebuilt, and `AutoMixer`'s eager preload can be evicted mid-flight.
The user sees a queue that never settles — which reads as "the suggestions are
random" even when each individual pick is defensible.

### P5 — No artist / no diversity constraint

`songCore` dedups the *same song* (different uploads), and `played` remembers 100
video ids. Nothing prevents five tracks by the same artist in a row, which is exactly
what a YouTube watch-next feed hands you for a seed. There is no artist cooldown, no
"max N per artist per hour", no channel diversity.

### P6 — Dev and prod recommend different things

The client sends `isrc`, `title`, `artist` (`media/recommend.ts:19`). The **prod**
worker reads them and runs the Tidal track-radio tier. The **dev** server ignores all
three (`server/api.ts:444` reads only `v`, `limit`, `provider`) and never builds a
`providerRadio` closure. So local development exercises a strictly worse recommender
than production — any tuning done in dev is tuning the fallback path.

Also: prod's Tidal tier resolves each radio result back to a videoId with **one
YouTube search per track** (8 searches per fill, ×3 seeds = up to 24 subrequests on
one `/api/recommend`). That is slow and fragile enough that it likely fails soft and
silently drops to the YouTube floor under load.

### P7 — No energy or structural model

Selection knows about key and tempo. It does not know loud vs quiet, dense vs sparse,
intro-y vs peak. A real auto-DJ builds an arc. `smartSortChain` is a greedy
nearest-neighbour walk that optimises each hop locally and wanders globally.

### P8 — The transition vocabulary is one move

Every mix is: crossfade linearly over N bars, swap bass at bar `bassSwapBar`, maybe
swap stems. Bars and style vary with the mixability score, but the *gesture* never
does. There is no echo-out, no loop-extended outro, no filter-sweep-to-silence-and-
drop, no cut on the downbeat of a chorus. After three transitions you have seen all
of them.

### P9 — No gain staging

`Deck.loudness` is computed and cached and never consulted. A quiet 2009 upload
blended into a loud 2023 master is a visible level jump. This is the loudest
"amateur" tell in the whole feature and it is one line of arithmetic away from fixed.

### P10 — Mix points ignore the section labels

`computeMixOut` picks the phrase boundary nearest a target time. It has
`phraseLabels` available (rekordbox-style A/B/C/D repeat letters from the new chroma
SSM structure detection) and does not read them — so it cannot prefer "mix out of the
last chorus repeat" or "bring the incoming in at its first B section". `computeMixIn`
similarly uses only the first phrase past `firstSound`.

---

## 3. Redesign

Two independent tracks. **Track A fixes the picks; Track B makes the deck perform.**
They can ship separately and Track A is the higher-value one.

### Track A — the selector

Replace the "3 recent plays → 3 radios → merge" scheme with an explicit **session
context + candidate pool + scored pick**.

#### A1. Restore the anchor, properly

Make `ensureNext(ctx)` take a real, typed context instead of ignoring its argument:

```ts
interface RadioContext {
  anchor: TrackMeta | null;   // the vibe the user set — weighted, decays slowly
  current: TrackMeta | null;  // what is playing
  recent: TrackMeta[];        // last N plays, for exclusion not for seeding
}
```

Seed the provider fetch from **anchor + current** (2 seeds, not 3 sliding ones), and
use `recent` purely as a *negative* signal. This kills P1 and P2 together: the seed
set stops sliding every song, so the pool stops being self-similar, and the set stays
tethered to what the user chose.

The anchor should decay — after ~6 tracks of AUTO the user's original pick is not the
vibe any more. Weight it `max(0.25, 1 - played_since_anchor / 8)`.

#### A2. Persist a candidate pool

Right now every fill is a fresh fetch whose results are ranked and mostly discarded.
Instead keep a **pool** of ~60 scored candidates in a ref, fed by the provider fetch,
and *draw* from it:

- Fill the pool when it drops below ~20, not every song.
- Draw the top-scoring eligible candidate; remove it from the pool.
- A candidate stays in the pool across songs, gaining `usePrefetch` analysis while it
  sits there — which is what finally makes P3's harmonic term real.

This also fixes P4: the visible queue becomes append-mostly (top up to
`RADIO_MIN_AHEAD`), stable between songs, and the eager preload stops being evicted.

#### A3. Real scoring

```
score = w_rel · providerRelatedness        (backbone)
      + w_key · harmonicFit(prev, cand)
      + w_bpm · tempoFit(prev, cand)
      + w_energy · energyFit(target_energy, cand)
      − p_artist · artistRecency(cand)      (P5)
      − p_repeat · playedRecency(cand)
      + w_analysed · (cand has real analysis ? 1 : 0)
```

Two deliberate changes to how unknowns are handled:

- Stop returning a neutral `0.5` for unknown key/BPM. Split it: a *known-good* match
  scores high, a *known-bad* scores low, an *unknown* gets a small penalty. Right now
  an unanalysed track and a perfect harmonic match are only 0.2 apart in final score;
  an unanalysed track should be mildly disfavoured, which naturally promotes tracks
  the prefetcher has already done work on.
- `artistRecency`: hard-block the same artist within 2 tracks, penalise within 6.
  This is the cheapest single win against "repetitive".

`energyFit` needs an energy number per track. We already compute a peak pyramid with
3-band energy (`analyze.ts:13`) and `Deck.loudness` — derive a scalar
`energy = f(rms, high-band ratio, bpm)` in `analyzeTrackAsync`, store it alongside
bpm/key in D1 (an `ANALYSIS_VERSION` bump), and the whole arc idea becomes available.

#### A4. Energy arc (the "it's DJing" part)

With an energy scalar, AUTO gets a target curve rather than a nearest-neighbour walk:

- **Ride** (default): hold energy within ±0.15 of the current track.
- **Build**: +0.05 per track up to a ceiling, then a release.
- **Journey**: slow sine over ~10 tracks.

Expose as a 3-way selector in the queue panel. This is what turns "next song" into "a
set" and it is entirely a scoring-weight change once the scalar exists.

#### A5. Fix the server tiers

- Dev route: read `isrc`/`title`/`artist` and build the same `providerRadio` closure
  the worker does. One route should not be a strictly worse recommender than the
  other. (Extract the closure into `server/providerRadio.ts` and call it from both.)
- Tidal→YouTube resolution: batch and cache. One `search` per radio result, uncached,
  is the reason the tier probably isn't firing in practice. Cache
  `isrc → videoId` in D1 permanently; it never changes.
- Add a **second** provider tier while we're here: YouTube Music's own
  `watchPlaylistEndpoint` radio (`RDAMVM<videoId>`) is far more music-coherent than
  the generic watch-next sidebar and needs no extra credentials. That alone would
  visibly improve pick quality.
- Raise the client `limit` from the default 30 — the pool wants breadth.

### Track B — the performer

Give the mixer more than one move, and make it use the mixer controls a human uses.

#### B1. Gain staging (do this first, it's ~15 lines)

At preload, compare `live.loudness` and `inc.loudness`; set `inc.setTrim()` so the
incoming lands at the outgoing's perceived level, clamped to ±6 dB. Restore at
`settle`. Fixes P9 outright.

#### B2. Structure-aware mix points

Use `phraseLabels` in `computeMixOut`/`computeMixIn`:

- Prefer a mix-out at the boundary *leaving* the final repeat of the most-repeated
  label (the last chorus) rather than the nearest boundary to an arithmetic target.
- Prefer a mix-in that lands the incoming's first *body* section (first label that
  repeats later) at the end of the blend — currently approximated by "first phrase
  past firstSound".
- Choose blend length from the **actual section length** at the mix-out point rather
  than a fixed 12/16/24 bars, so the blend fits the phrase instead of straddling it.

#### B3. A transition vocabulary

Make `TransitionStyle` a real set with a picker that considers structure and adds
controlled variation (never the same style twice in a row when alternatives score
within tolerance):

| Style | Move | Uses |
|---|---|---|
| `blend` | today's EQ3 blend | existing |
| `stemswap` | today's arrangement swap | existing |
| `filter` | today's sweep | existing |
| `cut` | today's hard cut | existing |
| `echoOut` | throw `DelayFx` on the outgoing at the last downbeat, kill its fader, incoming already running | `FxRack`, `Deck.setLevel` |
| `loopExtend` | outgoing `setBeatLoop(4)` on its outro so a long incoming intro has runway, exit on the drop | `Deck.setBeatLoop`, `exitLoop` |
| `dropSwap` | filter+gate the outgoing to nothing across 4 bars, cut to the incoming's drop on the downbeat | `Deck.setFilter`, `GateFx`, `computeMixIn` |
| `spinOut` | `spinback()` out of the outgoing into the incoming's "1" — for a cut-worthy clash | `Deck.spinback` |

Gate each on preconditions (`echoOut` needs a free FX slot; `loopExtend` needs a
gridded outro; `dropSwap` needs a detected drop on the incoming) and fall back down
the list. The AutoMixer already has the "upgrade the plan at mix time" pattern from
`blend → stemswap`; this generalises it.

#### B4. Micro-performance during the blend

Small things that read as "a person is doing this":

- Nudge `setEqHigh` on the incoming up ~2 dB as it becomes the lead, back to 0 at settle.
- A one-bar `GateFx` stutter on the outgoing at the bass swap, when the plan is confident.
- Hot-cue the incoming's drop so `Mix now` has somewhere musical to go.

All optional, all behind a "Performance" intensity setting (Subtle / Standard /
Showy) so the user can turn the personality down.

#### B5. Make the state machine's dead limbs live or remove them

Either wire `radioSeedSet`'s output into the new `RadioContext` (A1) — the intended
fix — or delete the function, its tests and the `anchor` field. Right now it is 40
lines of load-bearing-looking code, plus tests, that does nothing, and the comments
around it actively mislead. Do not leave it as-is.

---

## 4. Suggested order

| # | Change | Cost | Payoff |
|---|---|---|---|
| 1 | B1 gain staging | XS | immediate, audible |
| 2 | A1 restore anchor into a typed `RadioContext` | S | fixes the drift |
| 3 | A3 artist cooldown + non-neutral unknown handling | S | fixes the repetition |
| 4 | A2 candidate pool (stops the per-song tail rebuild) | M | queue stops churning; makes prefetch pay off |
| 5 | A5 dev/prod parity + ISRC→videoId cache + YTM radio tier | M | better raw candidates |
| 6 | B2 structure-aware mix points | M | transitions land musically |
| 7 | A4 energy scalar + arc | M | "it's building a set" |
| 8 | B3 transition vocabulary | L | "it's DJing" |
| 9 | B4 micro-performance | S | polish |

1–3 are a day and would fix most of what is complained about. 4–5 are the structural
fix. 6–9 are the "sit back and watch" feature.

## 5. What to measure

There is a dev trace harness already (`aff9fcc`, `.htl-debug.log`). Log per fill:
seed ids, pool size, candidates fetched, how many had analysis, the winning score and
its components, and the artist-repeat distance. Without that, tuning the weights in
§A3 is guesswork.


---

## 6. Outcome — what actually shipped

All nine steps in §4 landed in one session. Everything below is in the tree.

| # | Change | Where |
|---|---|---|
| 1 | Gain staging (`gainTrim`, ±6 dB to a fixed reference, never fights a manual trim) | `autoMixer.ts` |
| 2 | The anchor restored as a typed `RadioContext`; `radioSeedSet` deleted | `types.ts`, `autoMixer.ts`, `queue.ts` |
| 3 | Real scoring: artist cooldown, non-neutral unknowns, decomposed + traced | `selector.ts` (new) |
| 4 | Persistent 60-candidate pool; the queue is append-mostly | `queue.ts` |
| 5 | Dev/prod tier parity, permanent ISRC→videoId cache, YouTube Music radio tier | `providerRadio.ts` (new), `recommend.ts`, `innertube.ts`, migration 0028 |
| 6 | Structure-aware mix points off `phraseLabels`; phrase-fitted blend length | `mixPoints.ts` (new) |
| 7 | Perceptual `energy` scalar + three arcs, with a UI picker | `analyze.ts`, migration 0029, `MixQueuePanel.tsx` |
| 8 | Seven-gesture vocabulary + anti-repetition (`resolveStyle`) | `mixability.ts`, `autoMixer.ts` |
| 9 | Micro-performance behind Settings ▸ Auto-DJ performance | `autoMixer.ts`, `ControlsTab.tsx` |

### Measured, not assumed

- **The candidate supply was the hidden cause.** Against the same seed, the old
  sole source (watch-next) returned **6** candidates; the new YouTube Music radio
  tier returns **33**. A pool of six, re-fetched every song, could not have been
  anything but repetitive.
- **Three bugs surfaced from the new trace log itself**, none of which were
  visible from reading the code:
  1. `songCore` never stripped a leading `Artist - ` prefix, so `Teardrop
     (Remastered 2019)` and `Massive Attack - Teardrop (Live in Berlin)` produced
     different keys — the radio followed a track with *itself*.
  2. Covers and tributes name the song mid-sentence (`AURORA covers Massive
     Attack 'Teardrop' for Like A Version`) and are uploaded by channels that are
     not the artist (`triple j`, `Nb Music`), so neither the song-key nor the
     artist-key comparison could see them. Both now also look *inside* the title.
  3. Compilations and non-music (`(fan-voted) top 100 most recognizable songs`, a
     Technoblade memorial montage) were reaching the pool through both YouTube
     tiers. `isNonSong` is a deliberately tight filter — it contains no musical
     words like "live", "mix" or "remix", only phrases naming a *collection*.

  Before / after, same seed, one page load:

  | before | after |
  |---|---|
  | Teardrop → **Teardrop (Live)** → Dissolved Girl → **AURORA covers 'Teardrop'** | Cartel de Santa → Fuerza Regida → Wisin & Yandel → Lefty SM |

### Known limits

- **Dev has no D1**, so `fetchAnalysisBatch` returns nothing locally and the pool
  scores on relatedness alone (`analysed: 0` in the trace). The harmonic, tempo
  and energy terms only engage against a real database. Tune weights against
  production traces, not local ones.
- **The mixer's execution paths were not verified with live audio** — browser
  automation cannot satisfy Chrome's autoplay gesture requirement, so gain
  staging, the new gestures and the micro-performance are covered by unit tests
  and the state-machine suite rather than by a heard transition. They should get
  one manual listen before this is called done.
- The energy scalar's calibration is approximate by design; only its ordering is
  load-bearing. See the note above `trackEnergy`.

---

## 7. Second round — the mix itself

The first round made AUTO pick the right *records*. This round is about what
happens between them, and it opened with a bug report that turned out to be
about neither: **severe visual lag during an auto transition.**

### 7.1 The lag was the separator, not the mixer

`stems/gpuQueue.ts` has documented the mechanism all along — HT-Demucs runs on
WebGPU and the browser compositor draws from the same GPU. What the file
*solved* was two separations at once. One separation is enough to starve the
compositor on its own, and AUTO arranged for it to happen at the worst possible
moment: `ensurePreload` fires the incoming track's separation the instant the
deck arms, and `STEM_WAIT_MAX = 8` makes the mixer *wait* at mix-out for stems
that haven't landed. So the heaviest GPU job in the app ran while two waveforms
were scrolling and the crossfader was sweeping.

Two fixes, both about *when* the GPU is busy:

- **A quiet window.** `holdGpu()` is raised from cue to settle. No new job
  starts while it is up; a job already running is left alone, because WebGPU
  work cannot be preempted and killing it would trade minutes of compute for a
  few hundred milliseconds of jank. A counter rather than a flag, and every exit
  path lowers it — a leaked hold starves separation for the rest of the session.
- **Warm ahead.** `warmStems` separates the track *after* next, off-deck,
  doubling the lead. It rides the same `stemJobs` map, so the deck load later
  finds the in-flight promise instead of starting a second job. It deliberately
  does **not** populate the track cache: `loadTrackToDeck` reads a cache hit as
  "analysis already done" and skips both the stored-beatgrid read and the post
  back, so caching there would quietly stop every warmed track contributing its
  grid. It decodes a throwaway buffer instead.

Ruled out first, and worth recording so nobody re-suspects them: decode already
runs on a throwaway `OfflineAudioContext`, and stem resampling uses
`startRendering` — neither touches the main thread. `applyCrossfade` does write
App-root state every 150 ms with **zero memoized components in 64**, which is
real and additive, but measured at 4.4 ms median on an empty board. Not the
headline.

### 7.2 A transition has two halves

`TransitionStyle` was never the transition — it was the *outgoing* gesture.
Every branch of `tickMixing` spent its lines on the departing deck and tacked
one or two onto the end for the arriving one. Because those lines lived inside
the branch, the halves were welded: "filter the old track out" and "drop the new
one in on its downbeat" was unsayable.

`TransitionEntry` is now its own axis, with `DEFAULT_ENTRY` mapping every style
back to the arrival it already had. The two new entries are the previously
unreachable ones — `dropIn` holds the incoming back and lands it; `riseIn`
swells it in with the low end late. They are paired by what the exit *leaves
behind*: a collapsing gesture ends in a hole and a hole wants something to land
in it; a dissolving one leaves no hole and never gets a drop-in.

### 7.3 Three lessons that generalise

- **Two small deltas that disagree = the one with the head start always wins.**
  Shaping gesture choice by arc *and* by energy step, additively, made the
  energy term unable to ever matter — `blend` sits at index 0 *and* collects the
  ride bonus. A real step now **overrides** the arc rather than arguing with it.
- **A fraction of a transition is a different bar on every blend.** Every
  discrete FX moment was a constant like `p > 0.82`. On a 12-bar blend that is
  bar 9.84 — the freeze lands *after* the downbeat. `barsLeft` is free, because
  `blendBarsFor` and `chooseMixOut` already align the transition to the outgoing
  track's phrases, so a bar line inside it is a bar line in the music.
- **Spreading rungs across the available runway is not an accelerando.** The
  loop ladder scaled every rung by `runway/ladder`, so the one-beat rung was
  held for two and a half beats. Measuring *backwards* from the release point
  gives each rung exactly its own beats.

### 7.4 The test-fake hazard, twice more

`FakeDeck.setEqLow`, `setFilter` and `setStemGain` are no-ops that record
nothing — so **no test has ever observed a transition's incoming shaping or its
stem envelope.** Extracting either would have been unverifiable, and a green
suite would have said nothing about whether the app still sounded the same.
`entryRamp`, `stemBlend`, `rollLadder` and `barsLeft` are therefore pure and
exported, and golden-tested against the pre-refactor formulas written out
longhand. Separately, `FakeQueue` lacked the real queue's `arc`, which would
have sent every newly-shaped branch down the neutral path.

This is the same failure that bit round one (see §6). The rule it keeps
teaching: **when a fake's method returns void, ask what the suite can still
see.**

### 7.5 Still unheard

Everything in §7 is verified by unit test, typecheck and build. None of it has
been heard. The autoplay gesture requirement still blocks driving a real
transition under browser automation — obligation `cb7f25d6`.
