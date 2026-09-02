# Control surfaces — MIDI, gamepad, keyboard

Four ways to drive the same deck. The design rule is that **they converge early**:
every surface decodes to a normalized event and enters the *same* action handlers
the on-screen buttons call. There is no second implementation of "play" anywhere.

```
keyboard ─┐
MIDI ─────┼──▶ onMidiEvent ──▶ the same actions the UI calls
gamepad ──┘
touch/mouse ──▶ the UI
```

That path lives in `src/App/useMidiRouting.ts`. A feature that is reachable from a
button is reachable from hardware for free; one that is wired only in a component
is not, and that asymmetry is the usual cause of "the controller can't do X".

## The MIDI layer

`src/htl/midi/` — and note the split, because only the *profile* has ever been
documented ([ddj-flx4.md](./ddj-flx4.md), hardware-verified, and the authoritative
map).

| File | Owns |
|---|---|
| `MidiEngine.ts` | pure I/O: MIDIAccess, port enumeration, hot-plug, the per-device keep-alive handshake, LED feedback, MIDI-Learn capture |
| `decode.ts` | raw bytes → values: 7-bit notes, **14-bit CC pairs**, relative jog ticks (`centeredDelta`, `twosComplementDelta`, `wrappingStep`) |
| `maps.ts` | saved, shareable named maps |
| `controls.ts` | the addressable control vocabulary (what a binding can point at) |
| `profiles/` | per-device maps; `matchProfile` picks one on connect |

Every decoded control becomes a normalized `MidiEvent`. **The engine never touches
a deck** — it hands events out and the routing layer decides.

Availability is narrower than people expect: **Web MIDI is Chromium desktop**.
Everything degrades to the keyboard and the UI.

### The hardware trap worth knowing before you touch the FLX4

Driving the "smart" lamps (CFX / FADER / ON-OFF) **engages latching hardware
features** on the unit — it remaps COLOR to a trim CC and flips button channels,
and the device then behaves differently from its own documentation. Force those
off; never write `0x7F` to them. The full map and its traps are in
[ddj-flx4.md](./ddj-flx4.md).

## Gamepad

`src/htl/gamepad/` (small). An Xbox pad becomes a DJ surface by translating into
the *same* `onMidiEvent` path — which is why it inherits deck focus, session sync
and scratch behaviour without reimplementing any of them. It adds one thing of its
own: predictive Bluetooth beat-rumble, which has to run ahead of the beat because
BT haptics land late.

## Keyboard

A full map with `Tab` for deck focus and a per-deck keymap; one `App` keydown
handler mirrors the on-screen buttons, and Shift is respected as the same modifier
the UI shows. Remappable in Settings ▸ Controls.

## Profiles

MIDI maps, colour themes and keymaps all save as **named, shareable profiles** and
ride account sync ([sync.md](./sync.md)) — the same LWW blob contract as the preset
banks, and the same 256 KB cap. A profile that embeds a full MIDI map is the one
part of that blob with no fixed ceiling, so it is the growth vector to watch.
