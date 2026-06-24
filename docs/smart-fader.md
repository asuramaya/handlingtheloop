# Smart Fader

Our take on the Pioneer DDJ-FLX4 **Smart Fader** — a crossfader-*driven* auto-transition. Where
the [AutoMixer](../src/htl/automix/autoMixer.ts) runs a transition on a wall-clock timer, Smart
Fader makes the **crossfader position itself** the transition progress: arm it, then physically
throw the fader from the live deck to the other and the blend rides your hand.

Code: `src/htl/automix/smartFader.ts` (the `SmartFader` controller), wired in `App.tsx`.

## What it does

On **arm** (`SmartFader.arm(cf)`):
- Picks the **live** deck = the side the fader currently favours (centre → whichever is playing).
- Beat-locks the **incoming** deck to the live tempo via SYNC and starts it rolling (under the
  still-fully-live-side crossfader, so you don't hear it yet).
- Drops keylock on both decks so the tempo morph reads as a turntable-style pitch glide.
- Bails (returns `false` → plain crossfader) if either deck lacks a beatgrid to morph between.

On every **fader move** (`onCrossfade(cf)`), with progress `p` (0 = on live … 1 = on incoming):
- **Tempo morph** — only the **live (master)** deck's tempo is moved to `lerp(liveStartBpm, incBpm,
  p)`; the incoming is a **SYNC slave** and follows (half/double folded for big gaps). The pair
  stays beat-locked while the common tempo migrates from the live track's *current* BPM (so arming
  never snaps a deck the DJ had pitched) to the incoming track's natural BPM. This is the
  genre-bridge trick.
- **Bass swap** — the live LOW EQ cuts to the incoming's across the middle of the throw
  (`BASS_LO=0.30 … BASS_HI=0.70`) so the two basslines never stack.
- **Crossfade** — the equal-power curve just follows the fader.

**Pitch glide is deliberate.** Key-lock is dropped while armed, so the tempo morph pitches the
decks like a turntable — the genre bridge *sounds* like one. That continuous, sub-semitone pitch
shift is **surfaced** in each deck's key badge (`Deck.liveKey` / `livePitchSemis`): the Camelot key
tracks the nearest semitone and a `±N¢` cents read-out shows the live drift (the integer `pitch`
field can't). Disarm restores each deck's original key-lock.

At `p≈1` the throw completes — the incoming is live at its own BPM — and Smart Fader **re-arms in
the reverse direction** (stays in Smart mode) so the strip keeps its blend look and the next throw
blends back. Toggle the button (or SHIFT+button) to exit; that returns both decks to neutral.

## Controls (DDJ-FLX4)

- **SMART FADER** (unshifted, `0x96/0x01`) → arm / disarm Smart Fader.
- **SHIFT + SMART FADER** (`0x96/0x09`) → enable / disable the crossfader entirely (the old toggle).

We always force the FLX's *hardware* Smart-CFX/Fader features **off** (we send `0x96/0x00` and
`0x96/0x01` = `0x00`, never `0x7F`), so these buttons drive our software versions, never Pioneer's
— the hardware feature would otherwise remap the COLOR knob onto trim and take over the channels.
See [ddj-flx4.md](./ddj-flx4.md).

On-screen: while armed the whole crossfader strip becomes a breathing **A↔B blend gradient** (the
deck accent colours) to read as "blendy"; dragging it scrubs the transition just like the hardware
fader. Each deck's key badge highlights and shows live cents while the pitch glides.

## Why it was cheap to build

Every DSP move already existed and was proven by the AutoMixer: `setTempo` (WSOLA-glided, no
artifacts), `setEqLow` (the low-shelf, `EQ_KILL=-26`), the equal-power crossfade curve, SYNC
phase-lock, and beatgrid BPM. Smart Fader is a new **driver** for them, not new DSP.

## Tuning / v2 ideas

- **Echo tail** on the outgoing deck near the end of the throw (needs an FxRack delay throw) — the
  one Pioneer flourish not yet built.
- **Eased BPM curve** instead of linear `lerp` (e.g. hold the live tempo longer, then ramp).
- **Bass-swap window** position/width (`BASS_LO`/`BASS_HI`).
- **Key-match option** — pitch the incoming to the live deck's key on arm (the AutoMixer's
  `toggleKey` path) so the blend is harmonic, not just beat-locked.
- Phrase-aware arming (snap the transition length to the incoming track's phrasing, reusing
  `mixability.ts`).
