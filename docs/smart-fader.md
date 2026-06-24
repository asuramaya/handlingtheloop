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
- **Tempo morph** — both decks held beat-locked at `lerp(liveBpm, incBpm, p)`, so the pair stays
  matched while the common tempo migrates from the live track's BPM to the incoming track's own
  BPM. (At `p=0` the incoming is pulled to the live tempo; at `p=1` the live is pushed up/down to
  the incoming tempo and the incoming sits at its natural BPM.) This is the genre-bridge trick.
- **Bass swap** — the live LOW EQ cuts to the incoming's across the middle of the throw
  (`BASS_LO=0.30 … BASS_HI=0.70`) so the two basslines never stack.
- **Crossfade** — the equal-power curve just follows the fader.

At `p≈1` the throw is complete: the incoming is live at its own BPM, the outgoing is reset to
neutral tempo/EQ/keylock (still faded out), and Smart Fader stands down (next move = plain fader).

## Controls (DDJ-FLX4)

- **SMART FADER** (unshifted, `0x96/0x01`) → arm / disarm Smart Fader.
- **SHIFT + SMART FADER** (`0x96/0x09`) → enable / disable the crossfader entirely (the old toggle).

We always force the FLX's *hardware* Smart-CFX/Fader features **off** (we send `0x96/0x00` and
`0x96/0x01` = `0x00`, never `0x7F`), so these buttons drive our software versions, never Pioneer's
— the hardware feature would otherwise remap the COLOR knob onto trim and take over the channels.
See [ddj-flx4.md](./ddj-flx4.md).

On-screen: the crossfader bar shows a pulsing **SMART** badge and tints while armed; dragging it
scrubs the transition just like the hardware fader.

## Why it was cheap to build

Every DSP move already existed and was proven by the AutoMixer: `setTempo` (WSOLA-glided, no
artifacts), `setEqLow` (the low-shelf, `EQ_KILL=-26`), the equal-power crossfade curve, SYNC
phase-lock, and beatgrid BPM. Smart Fader is a new **driver** for them, not new DSP.

## Tuning / v2 ideas

- **Echo tail** on the outgoing deck near the end of the throw (needs an FxRack delay throw) — the
  one Pioneer flourish not yet built.
- **Eased BPM curve** instead of linear `lerp` (e.g. hold the live tempo longer, then ramp).
- **Bass-swap window** position/width (`BASS_LO`/`BASS_HI`).
- Phrase-aware arming (snap the transition length to the incoming track's phrasing, reusing
  `mixability.ts`).
