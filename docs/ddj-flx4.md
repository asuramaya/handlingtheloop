# DDJ-FLX4 mapping (HTL)

Complete, hardware-verified MIDI map for the Pioneer/AlphaTheta DDJ-FLX4, as wired in
`src/htl/midi/profiles/ddj-flx4.ts`. Most numbers were **read off the unit's MIDI monitor**
this session — the community Mixxx map was wrong about several (the two "analog" level knobs
actually transmit; the rotary selector is 2's-complement; etc.), so treat the monitor as the
source of truth, not the Mixxx XML.

The FLX is class-compliant but stays half-asleep until it gets the Pioneer SysEx handshake,
repeated every 200 ms (`FLX4_HANDSHAKE` / `keepAliveMs`).

## Status bytes

| Section | Note status | CC status |
|---|---|---|
| Deck A | `0x90` | `0x0B` |
| Deck B | `0x91` | `0x1B` |
| Deck A pads | `0x97` | — |
| Deck B pads | `0x99` | — |
| Mixer / global | — | `0xB6` |
| Browse + LOAD + SMART | `0x96` | `0xB6` |
| BEAT FX | `0x94` (mirror `0x95`) | `0xB4` (mirror `0xB5`) |

Pioneer SHIFT sends its OWN distinct notes for many controls (not a software flag): e.g. SHIFT
loop-in is a different note than loop-in. Bind the shifted note with `shift: true` so it hits the
shifted branch. (A `shift:true` binding sets `shiftOverride`, so `ev.shift` is true regardless of
deck — see `MidiEngine.dispatchNote`.)

## Transport / loop / jog (per-deck note)

play `0x0B` · cue `0x0C` · sync `0x58` · loopIn `0x10` · loopOut `0x11` · loopExit (RELOOP) `0x4D`
· SHIFT in/out/exit `0x4C`/`0x4E`/`0x50` · SHIFT cue `0x48` / play `0x0E` · CUE/LOOP-CALL ◀ `0x51`
▶ `0x53` (jogBack/jogFwd; SHIFT variants `0x3D`/`0x3E` move the loop) · SHIFT-SYNC `0x60` → keyMatch
· SHIFT button `0x3F` · jog touch `0x36`.

Jog wheel CCs: scratch `0x22`, bend `0x23`, outer ring `0x21`, SHIFT-search `0x29`.

## Performance pads — position, not bank

The FLX emits a DIFFERENT 8-note block per hardware pad-mode bank: HOT CUE `0x00–07`, BEAT JUMP
`0x20–27`, SAMPLER `0x30–37`, PAD FX1 `0x40–47` (pad status). **All four blocks map to the same
generic `hotcue1..8`** (`padBanks()`), so pad *position* is what matters and HTL's own pad mode
(cue/loop/sampler/fx) decides behaviour. The bank BUTTONS switch HTL's pad mode 1:1 (note status):
HOT CUE `0x1B`→cue · PAD FX1 `0x1E`→fx · BEAT JUMP `0x20`→loop · SAMPLER `0x22`→sampler. Those same
notes get LED feedback (`feedback.padModes`).

## Faders / knobs (14-bit CC on the deck/mixer channel)

tempo `0x00` · level `0x13` · trim `0x04` · eqHi `0x07` · eqMid `0x0B` · eqLow `0x0F` · CFX/filter
deck A `0xB6/0x17`, deck B `0xB6/0x18` · crossfader `0xB6/0x1F`.

TRIM (deck channel `0xB0/0xB1 0x04`, LSB `0x24`) and the COLOR/filter knob (mixer `0xB6 0x17/0x18`)
are **separate** knobs on distinct CCs. (An earlier note claimed the FLX4 had no trim knob and
that the color knob duplicated onto `0x04` — that was a misread of the trim knob sweeping `0x04`.)

## Left column — the "analog" knobs that aren't (mixer-global `0xB6`, 14-bit)

MIC LEVEL MSB `0x05` → `micLevel` · 🎧 MIX (CUE↔MST) MSB `0x0C` → `cueMix` · 🎧 LEVEL MSB `0x0D`
→ `cueLevel`. (LSB = MSB+`0x20`.) The Mixxx map claimed mic/phones level were analog — they
transmit. `cueMix`/`cueLevel` only do anything with a 2nd (cue) output device set; they drive the
new headphone bus (see [[htl-headphone-cue]]). The mic/cue cells stay in step with the knobs.

## Browse section (`0x96` / `0xB6`)

browse rotate `0xB6/0x40` — **2's-complement relative** (`0x01`=+1, `0x7F`=−1), NOT centred on
`0x40` like the jog, so decode `val<64?val:val−128` (or it leaps ±63 rows/detent). browse PRESS
(selector) `0x96/0x41` → toggle the library cursor between the track list and the source list
(rekordbox tree↔list). LOAD A `0x96/0x46`, LOAD B `0x96/0x47` → load the cursor row. See
[[htl-library-ui]] for the cursor.

## SMART buttons (`0x96`)

SMART CFX `0x00` → `eqStemToggle` (flip the HI/MID/LOW/CFX knob column between EQ/filter and STEM
volume — HI→drums, MID→bass, LOW→vocals, CFX→other; needs separated stems). SMART FADER `0x01` →
`xfaderToggle` (enable/disable the crossfader + recentre to 50%). *If these feel swapped on a unit,
swap the two data bytes.*

## BEAT FX section (`0x94`)

The section targets the FOCUSED deck; the **1·2 switch** moves focus (pos 1 `0x94/0x10` → focus A,
pos 2 `0x95/0x11` → focus B; at "1&2" both fire — true "both" deferred).

| Control | Note / CC | Unshifted | SHIFTED (own note, `shift:true`) |
|---|---|---|---|
| FX SELECT | `0x63` / SHIFT `0x64` | add-mode toggle + commit | remove selected effect |
| BEAT ◀ | `0x4A` / SHIFT `0x66` | nav selection / add candidate | reorder selected ← |
| BEAT ▶ | `0x4B` / SHIFT `0x6B` | nav selection / add candidate | reorder selected → |
| ON/OFF | `0x47` / SHIFT `0x43` | bypass selected effect | reset selected effect |
| LEVEL/DEPTH | `0xB4/0x02` 14-bit | selected effect wet/dry (`mix`) | — |

Add-mode reuses the existing FxStrip `+`/dropdown: FX SELECT opens it, BEAT ◀▶ highlight a palette
row, FX SELECT commits. Nav/add-mode are driven through an `FxStripCtl` imperative handle
(App→DeckControls→FxStrip). EQ is a permanent channel-strip device (can't remove/duplicate). See
[[htl-fx-rack]].

### ON/OFF LED — UNCONFIRMED

The ON/OFF lamp is driven on the ~7 Hz feedback loop to `0x94/0x47` from the focused deck's
selected-effect active state. `0x7F` made it **blink** (Pioneer LED-code), so it's on `0x01`
(solid) / `0x00` (off) pending a Debug output-prober sweep — the FLX may also own this LED in
firmware. **OWED: prober sweep of `94 47 00/01/02/7F` → off/solid/blink.**

## Other open items

- SMART CFX/FADER `0x00`/`0x01` orientation not confirmed (swap if reversed).
- True "1·2·**1&2**/both" deck targeting deferred (both notes fire; last wins → lands on B).
