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
height-anchored to a shared `--fx-body-h` so every tab and both decks stay aligned.

### Delay (`DelayFx.ts` + `DelayPanel.tsx` + `DelayViz.tsx`)

A stereo dub/DJ delay modelled on the Waves H-Delay (character) and Arturia Delay Eternity
(architecture): two delay lines with band-pass'd feedback, **Mono / Ping-Pong** topologies,
**Repitch / Digital / Fade** time-change modes, **Freeze** (infinite hold), filtered
feedback (HP+LP+LINK), analog **DRIVE** + **LoFi** bitcrush (worklet-free waveshapers),
**modulation** (LFO → delay time), **ducking** (pure-Web-Audio sidechain), and **WIDTH**
(L/R time offset for organic stereo). The panel is a 5×2 knob grid under an **echo-tap
visualization** (predictive: taps decay by feedback over a beat-grid; ping-pong splits
L/R; freeze holds).

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
