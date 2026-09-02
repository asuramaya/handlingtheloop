# Channel-strip FX rack + Sampler

Two per-deck performance subsystems added on top of the audio engine. Both are
client-side only (no extra server load beyond the sampler's optional file storage) and
sync across a shared session through the existing intent/snapshot protocol.

## FX rack — an Ableton-style channel-strip

Each deck owns an ordered **device chain** (`FxRack`, `src/htl/audio/Fx.ts`) spliced into
its signal path:

```
source → rack.input → [dev0] → [dev1] → … → [devN] → rack.output → trim → fader → crossfader
```

- **`FxDevice`** is the contract every device implements: `input`/`output` gain nodes, a
  `bypass`, a generic string-addressed param bus (`setParam`/`getParam`/`snapshotParams`),
  `reset()`, and an optional `dispose()`. The single seam that session-sync, automix, and
  MIDI all address.
- **`BaseFxDevice`** is the base for wet/dry effects (delay/reverb/chorus): a dry
  pass-through in parallel with the subclass's wet graph, summed at `output`, with a `mix`
  param and click-free bypass.
- **`FxRack`** wires `chainIn → dev0 → … → output` and re-wires on add/remove/reorder
  (gain-node splices are glitch-free). A permanent inner `chainIn` keeps the deck's
  pre-rack spectrum tap alive across rebuilds.

**Every device is a first-class citizen — the EQ included.** `Eq3` implements `FxDevice`;
it's a single persistent instance (`deck.eq`) that can be pulled out of / pushed back into
the chain but is never destroyed, so the `eq*` proxies / colour filter / automix / MIDI
always have a live target. The EQ's *params* ride the existing `eq*` ControlParams; only
its *presence + position* ride the FX sync.

### UI — the tabbed strip (`FxStrip.tsx`)

A tab bar over one full-size device panel (so the EQ curve keeps its height), plus a shared
**BYPASS / RESET / COPY** toolbar that acts on the selected device (COPY mirrors it to the
other deck, adding it there if missing). Add a device from the `+` palette, **remove by
right-clicking its tab**, **drag a tab to reorder** the chain. Device bodies are
height-anchored to a shared `--fx-body-h` so every tab and both decks stay aligned (the var
lives on `.eq-pro` / `.fx-panel`; the EQ curve and the delay's `DelayViz` are the flexible
surplus-absorbers inside it).

### EQ — the parametric curve (`EqCurve.tsx` + `Eq3.ts`)

Five nodes dragged in 2D over a live spectrum (HP-cut · LOW shelf · MID bell · HIGH shelf ·
LP-cut). Drag = freq (X) + gain/Q (Y); shift-wheel = Q. Under the curve sits a **Pro-Q-style
band-edit subrow** — a numeric companion for the **selected** node (click any node to select;
it gets a brighter ring). The subrow shows that band's **buttonoids** (ValueCell scrollers):
HP/LP → `FREQ`·`RES`; LOW/MID/HIGH → `FREQ`·`GAIN`·`Q` plus a **SHAPE** *switch button*.

- **SHAPE** (a discrete cycler, not a scroller) flips each of LOW/MID/HIGH between **bell /
  lo-shelf / hi-shelf / notch** — it just swaps the biquad `type`, so the curve renderer
  (`getFrequencyResponse`) reflects it for free. Switching a shelf to bell/notch makes **Q
  live** (Web-Audio honours Q only for `peaking`/`notch`; shelves ignore it), so LOW/HIGH gain
  a real width control to match MID. Cells grey by shape: `Q` greys in shelf modes, `GAIN`
  greys in notch.
- Shapes ride the `eq*Shape` / `eqLowQ` / `eqHighQ` ControlParams (the same per-EQ sync path as
  the rest of the band params — see Session sync below), so they persist + sync 1:1.
- Deferred: **SLOPE** for the HP/LP cuts (12/24/48 dB-oct) — the one secondary param that needs
  cascaded biquads + curve-math changes, not just a `type` swap.
- **Colour:** the band cells (FREQ/GAIN/Q) carry the **deck** accent; only the band **select
  chip** (the `MID`/`LOW`/… label) carries the node's hue. The subrow sets `--band` (not
  `--accent`) so the buttonoids read as the deck and the select indicator reads as the band.
- **Sizing gotcha:** the subrow cells sit at the `.eq-subrow` height (≈38px), the deck's
  foot-row `ValueCell`s at 50px. Because `FxStrip` is wrapped in `.eq-row`, the deck rule
  `.eq-row .vcell{height:50px}` *leaks* onto these (and onto the delay's `.fx-knobs .vcell`)
  via the descendant combinator — they overflow their row. Guard with the device's own
  selector at higher specificity: `.eq-row .eq-subrow .vcell` / `.eq-row .fx-knobs .vcell`
  `{height:100%}` (0,3,0 beats 0,2,0). Touch any per-band cell height through those, not the
  shared rule.

### Delay (`DelayFx.ts` + `DelayPanel.tsx` + `DelayViz.tsx`)

A stereo dub/DJ delay modelled on the Waves H-Delay (character) and Arturia Delay Eternity
(architecture): two delay lines with band-pass'd feedback, **Mono / Ping-Pong** topologies,
**Repitch / Digital / Fade** time-change modes, **Freeze** (infinite hold), filtered
feedback (HP+LP+LINK), analog **DRIVE** + **LoFi** bitcrush (worklet-free waveshapers),
**modulation** (LFO → delay time), **ducking** (pure-Web-Audio sidechain), and **WIDTH**
(L/R time offset for organic stereo). The panel is a 5×2 knob grid under an **echo-tap
visualization** (`DelayViz.tsx`).

`DelayViz` is **three layers sharing one viewport** (imperative canvas) so the otherwise-
invisible character params can be seen:

1. **HP/LP filter** — a full-height bandpass *hill* backdrop (the echoes' tone window on a
   log-freq scale; flattens to full width when the cuts are parked open).
2. **DEPTH/RATE** — a **live scrolling LFO sine** (amplitude ∝ depth, wavelength ∝ rate, phase
   advances via `performance.now()` so it actually moves); the taps slide with it.
3. **Echo taps** — the predictive timeline: dry hit at t=0, taps decaying by `feedback^n` over a
   beat grid, ping-pong split L-up/R-down, **WIDTH** as an L/R x-split, **DUCK** as a sidechain
   dip recovering over ~½ beat, **DRIVE** as a warm glow, **Freeze** holds every tap.

It only runs an animation loop while the LFO is active (`depth>0 && rate>0`); otherwise it's a
single static draw (no idle rAF), and the canvas re-allocates only on real resize.

### Session sync (`protocol.ts` + `App.tsx`)

Additive, no server change (the room relays intents generically and stores the snapshot
opaquely):

- `{ kind: "fxParam", deck, slot, param, value }` — a live knob move (slot = rack index).
- `{ kind: "fxBypass", deck, slot, value }` — device bypass.
- `{ kind: "fxRack", deck, rack: FxSlot[] }` — add/remove/reorder + late-joiner catch-up.
- `DeckSnapshot.fx?: FxSlot[]` — the whole chain (order + presence + per-effect params;
  the EQ slot carries empty params). `applyFxSnapshot(undefined)` is a no-op so an older
  snapshot can't wipe a guest's EQ.

## Sampler — a 12-pad strip

`Sampler.ts` (voice engine) + `useSampler.ts` (state) + `SamplerStrip.tsx` (UI). Pads route
by **position**: 0–3 → deck A channel (`deckA.rack.input`, so the deck's FX shape them),
4–7 → master (global, cut through), 8–11 → deck B channel.

- **Region pads (A/B)** capture a slice of the loaded track (the active loop, else 4 beats
  from the playhead) — positions into `deck.buffer`, stored client-side per videoId.
- **Global file pads (master)** are uploaded clips (≤30 s, ≤12 MB), account-stored in R2+D1
  (`server/samples.ts` `handleSampleRoute`, wired in `worker/index.ts`; the table
  self-creates via `ensureUserSamples`, so the `0011_samples.sql` migration is optional).

Per-pad mode (oneshot/gate/loop) + gain; one voice per pad (retrigger replaces). MIDI:
`sampler0..11` learnable controls routed by position.


---

## Stem chains — the rack is a partition, not one line

*(2026-08 onward. The single ordered chain above is now the MASTER chain; a deck can
own several.)*

A **chain** claims a subset of the four separated stems and processes only those.
Stems are a **partition**: a stem has exactly one owner, so taking it takes it from
whoever held it, nothing is heard twice, and the chains sum back to the track. One
chain over all stems *is* the flat rack that shipped before chains, which is why
every slot-indexed caller kept working — `rack.list` is the master's devices, and
`rack.allDevices` is everything in signal order.

- `FxChain { id, name, stems, devices }`; `FxAddr { chain, kind }` replaces "slot N"
  wherever a chain matters. Kinds are unique **within** a chain, free **across** them.
- Chain order is arrangement only — chains are parallel, so reordering the row moves
  nothing in the graph.
- **Persistence**: `DeckSnapshot.fx` is the MASTER chain alone; the stem chains ride
  `DeckSnapshot.fxChains` (`FxChainSlot[]`). That field was missing until 2026-09-01,
  which meant a refresh silently returned you to one chain — worth knowing if you see
  an old bug report.
- Chain **ids are not restored** across a reload: they are per-deck sequence numbers
  that mean nothing afterwards. The NAME is what a DJ recognises and what is preserved.

## Preset banks — an arrangement, not a list

`src/htl/audio/fxPresets.ts` is the bank engine, and it serves **all ten banks**: the
nine devices *and* chains (`CHAIN_KIND`), because the engine only ever reads a leaf's
`name` and does not care what kind of body hangs off it.

```
FxRow   = FxLeaf | FxGroup          a top-level row: a preset, or a named section
FxLeaf  = FxBody | FxRef            a preset you own, or a REFERENCE to a shipped one
FxBody  = FxPreset | ChainPreset    {name, params} or {name, stems, kinds}
FxBank  = { rows: FxRow[], gone: string[] }        `gone` = tombstones, by name
```

Four rules, and they are the whole design:

1. **References, not copies.** An untouched factory preset is stored as `{ref: name}`,
   so its params still live in code and can be improved in a later release without
   going stale in a bank someone organised a year ago.
2. **Tombstones, not holes.** Deleting a shipped preset records the name in `gone`.
   That is also what distinguishes "I deleted everything" from a bank written before
   references existed — a legacy bank has rows, no refs and no tombstones.
3. **Freshness appends.** Any factory preset neither present nor suppressed is appended
   under a synthetic `NEW` section, so a release that adds presets still reaches you.
4. **Editing materialises.** Changing a referenced preset turns it into a row you own,
   with the shipped one still behind it — which is what `revert` returns to.

★ **Every mutation edits the RESOLVED list** (`ensureArrangement` → `resolveFxRows`),
never the stored rows. They differ by that synthetic `NEW` section, and while the
mutations edited the stored list, every index from `NEW` onward addressed a different
list than the one on screen — a drop into it hit `rows[undefined]` and returned
silently, which reads as "this preset is locked". If you add a mutation, take its rows
from `ensureArrangement`.

**Account sync** is two one-way legs, deliberately: the working copy stays in
localStorage (the menus and the hardware preset browse read it synchronously and
cannot await), every write announces itself into `settings.fxBanks`, and the inbound
direction writes the account's banks back down. That inbound hydrate must depend on
`settings.fxBanks` — the blob always arrives *after* mount — and is dirty-checked so
the outbound leg's own state update cannot loop it.

**The bank is a map of the device.** `fxBank.test.ts` holds every bank to four
invariants, discovered by iterating `FACTORY_PRESETS` so a new device is covered the
day it exists: sections of 2–4 with every preset inside one; one identical key set
across the bank (an omitted param INHERITS, so a partial preset is nondeterministic,
not smaller); no key shipped at a single value; and no two presets identical under two
names. Writing these found four devices' worth of controls that had shipped and been
demonstrated by nothing.
