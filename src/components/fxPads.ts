import type { Deck, FxKind } from "@htl/audio";
import { registerBoardAction } from "@htl/board/boardActions";
import { MOVE_PADS } from "./movePads";

// The deck's FX pad-mode bank ("Pad-FX") — 8 fixed performance effects over the one 8-pad
// bank (and the keyboard 1-8 when padMode === "fx"). The "Throws + Motion" shape:
//   row 1 (0-3) = effect THROWS:        ECHO  VERB  SAT   CRUSH
//   row 2 (4-7) = effects:              MOD   EQ    GATE  NOISE
// (The bank is complete — BRAKE/SPIN dropped to jog gestures as GATE/NOISE landed, and CENS
// followed them off the bank so the EQ — the 8th rack device — could have a pad of its own.)
// Every backing device is a PERMANENT resident of the rack (provisioned dormant on deck birth,
// see Deck.ensurePadFx), so all 8 pads are ALWAYS armed — no "add a Delay first" gating. `hold`
// effects fire on press and release on pointer-up (momentary). `kind` is the pad's backing rack
// device, so a right-click can reveal its control surface (absent = no device, e.g. CENS, which
// is transport-reverse). `active` lights a sounding pad. One table, shared by DeckControls
// (render + pointer) and App (keyboard 1-8), so the mapping never forks.
export interface FxPadDef {
  label: string;
  kind?: FxKind; // backing rack device, for "reveal its panel" (absent = no panel, e.g. CENS)
  hold: boolean; // true = momentary (down → on, up → off); false = one-shot trigger
  on: (d: Deck) => void;
  off?: (d: Deck) => void;
  active?: (d: Deck) => boolean; // lights the pad while sounding
  hint: string;
}

export const FX_PADS: FxPadDef[] = [
  { label: "ECHO", kind: "delay", hold: true, on: (d) => d.echoOut(true), off: (d) => d.echoOut(false), active: (d) => d.echoingOut, hint: "Delay-tail throw — repeats ring out on release" },
  { label: "VERB", kind: "reverb", hold: true, on: (d) => d.reverbOut(true), off: (d) => d.reverbOut(false), active: (d) => d.reverbingOut, hint: "Reverb-tail throw — the tail blooms on release" },
  { label: "SAT", kind: "saturator", hold: true, on: (d) => d.satThrow(true), off: (d) => d.satThrow(false), active: (d) => d.satThrowing, hint: "Saturation slam — drive boost while held" },
  { label: "CRUSH", kind: "crush", hold: true, on: (d) => d.crushThrow(true), off: (d) => d.crushThrow(false), active: (d) => d.crushThrowing, hint: "Bitcrush smash — bit/rate crush while held" },
  { label: "MOD", kind: "mod", hold: true, on: (d) => d.modThrow(true), off: (d) => d.modThrow(false), active: (d) => d.modThrowing, hint: "Modulation swirl — depth boost while held" },
  // The EQ is the channel EQ — always in circuit, so it can't go dormant-and-throw like the rest.
  // Its pad throws a CURVE: hold slams the armed preset in, release restores the curve you were
  // riding. Right-click reveals the panel + its preset menu (which is what arms the pad).
  { label: "EQ", kind: "eq", hold: true, on: (d) => d.eqThrow(true), off: (d) => d.eqThrow(false), active: (d) => d.eqThrowing, hint: "EQ curve throw — slams the armed preset, restores your curve on release" },
  { label: "GATE", kind: "gate", hold: true, on: (d) => d.gateThrow(true), off: (d) => d.gateThrow(false), active: (d) => d.gateThrowing, hint: "Trance-gate stutter while held" },
  { label: "NOISE", kind: "noise", hold: true, on: (d) => d.noiseThrow(true), off: (d) => d.noiseThrow(false), active: (d) => d.noiseThrowing, hint: "Noise riser — sweep up while held, cut on release" },
];

// ★ THE BANK IS THE PAD CHAIN — the focused chain in FX, the MASTER chain in FX2 (Deck.padChain,
// which is the single source both this render and the throws read). A pad is a pointer, slot i is
// device i of that chain, and pad order IS processing order — the same list the strip renders and the graph
// runs. Nothing is bound, so nothing can dangle; move a device and its pad moves with it.
// FX_PADS above stops being the bank and becomes the DEFINITION table: what a GATE pad does when
// there is a gate to do it to.
const BY_KIND = new Map<string, FxPadDef>(FX_PADS.filter((p) => p.kind).map((p) => [p.kind as string, p]));

// A device the throw table has no entry for — the COMP, or a stem chain's own EQ — is still a
// device in the chain, and a pad that reads "—" next to a comp you can see is a lie. So it gets a
// generic pad: the throw is its BYPASS. Same gesture, same latch/momentary, nothing special-cased
// at the surface.
const KIND_PAD = new Map<string, FxPadDef>();
function genericPad(deck: Deck, kind: FxKind, label: string): FxPadDef {
  const found = KIND_PAD.get(kind);
  if (found) return found;
  const dev = (d: Deck) => d.fxChain(d.padChain)?.devices.find((x) => x.kind === kind);
  const pad: FxPadDef = {
    label,
    kind,
    hold: true,
    on: (d) => dev(d)?.setBypass(false),
    off: (d) => dev(d)?.setBypass(true),
    active: (d) => {
      const x = dev(d);
      return !!x && !x.bypassed;
    },
    hint: "In / out of this chain",
  };
  KIND_PAD.set(kind, pad);
  void deck;
  return pad;
}

/** The eight slots for a deck, right now: the PAD CHAIN's devices in order, padded out — the
 *  focused chain in FX, the master chain in FX2. A null slot is an empty slot — it is not a broken
 *  pad, it is a chain with room in it. */
export function padsForDeck(deck: Deck): (FxPadDef | null)[] {
  if (deck.padMode === "fx2") return MOVE_PADS; // FX2 = the deck-moves bank (movePads.ts), not a chain
  const chain = deck.fxChain(deck.padChain) ?? deck.fxChain("master");
  const pads: (FxPadDef | null)[] = (chain?.devices ?? []).map((d) => BY_KIND.get(d.kind) ?? genericPad(deck, d.kind, d.kind.toUpperCase()));
  while (pads.length < 8) pads.push(null);
  return pads.slice(0, 8);
}

// ★ ONE GESTURE, THREE TRANSPORTS. Touch, keyboard and MIDI all press the same pad, so the
// press/release rule lives HERE, once, keyed by deck+slot rather than by input device. That also
// makes the transports interoperable: press with a finger, release with the key, and the pad
// behaves — because the held state belongs to the PAD, not to whoever pushed it.

/** The device a pad points at, in the chain the pads are aimed at. */
function padDevice(deck: Deck, pad: FxPadDef) {
  return pad.kind ? deck.fxChain(deck.padChain)?.devices.find((d) => d.kind === pad.kind) : undefined;
}
/** Is this pad's effect audible right now? A device can be live in TWO ways since a tap started
 *  latching it at the user's own mix: mid-throw (the device's own `throwing` flag) or simply
 *  un-bypassed. Reading only the first left a latched pad dark while its effect was running. */
export function fxPadIsOn(deck: Deck, pad: FxPadDef): boolean {
  if (pad.active?.(deck)) return true;
  const d = padDevice(deck, pad);
  return !!d && pad.kind !== "eq" && !d.bypassed; // the EQ is always in circuit; its pad is a curve throw
}
// ★ HOT BY DEFAULT, SHIFT LATCHES (operator, 2026-11-06: "im not too happy about … the hold/latch/
// toggle mechanic, i think letting them be hot by default and toggle on shifted mode may make more
// sense"). It used to hang on timing: a press under FX_HOLD_MS latched, a longer one was momentary,
// so the same finger did two different things depending on a fifth of a second. Now the gesture
// decides, not the clock:
//   • plain press  → the effect is ON while the pad is down, OFF on release. Always.
//     (A pad already latched stays on while held and goes OFF on release: a plain press is how
//     you take a latched effect out, momentarily or for good.)
//   • SHIFT+press  → TOGGLE the latch at once: dark → on (at your own dialled settings, not the
//     throw's slam), lit → off. The release does nothing.
// What is physically down: whether it was already lit (a latched pad being played through), or
// whether it was a SHIFT latch press (its release is inert).
const heldPads = new Map<string, { wasOn: boolean; latch: boolean }>();

/** Press. Plain: engage while held. SHIFT: toggle the latch now. Reports whether the effect went
 *  ON (`fired`, so the caller emits a down) or OFF (`off`, emit an up), and which device to reveal.
 *  Repeats are ignored — a held keyboard key auto-repeats forty times a second. */
export function fxPadPress(deck: Deck, deckId: string, slot: number, shift = false): { fired: boolean; off?: boolean; repeat?: boolean; kind?: FxKind } {
  const pad = padsForDeck(deck)[slot];
  if (!pad) return { fired: false };
  const key = `${deckId}${slot}`;
  if (heldPads.has(key)) return { fired: false, repeat: true, kind: pad.kind };
  const wasOn = fxPadIsOn(deck, pad);
  heldPads.set(key, { wasOn, latch: shift });
  if (shift) {
    if (wasOn) {
      padOff(deck, pad, true);
      return { fired: false, off: true, kind: pad.kind };
    }
    pad.on(deck);
    // A latch is the effect AS DIALLED: the throw's boost and mix floor are right for a momentary
    // slam but would leave a latched effect stuck at the throw's percentage, over the wet you set.
    padDevice(deck, pad)?.latchThrow?.();
    return { fired: true, kind: pad.kind };
  }
  if (wasOn) return { fired: false, kind: pad.kind }; // latched: already sounding; the release takes it out
  pad.on(deck);
  return { fired: true, kind: pad.kind };
}

/** Take a pad's effect out: end the throw and, for a LATCHED device (not thrown, just un-bypassed),
 *  bypass it. Never the EQ's bypass: that is the channel EQ, and its pad throws a curve. */
function padOff(deck: Deck, pad: FxPadDef, latched: boolean) {
  pad.off?.(deck);
  const dev = padDevice(deck, pad);
  if (latched && dev && pad.kind !== "eq" && !dev.bypassed) dev.setBypass(true);
}

/** Release. Plain press → the effect goes off (a latched one too). SHIFT latch press → nothing.
 *  Returns whether it actually released (so the caller emits an up). */
export function fxPadRelease(deck: Deck, deckId: string, slot: number): boolean {
  const key = `${deckId}${slot}`;
  const rec = heldPads.get(key);
  heldPads.delete(key);
  const pad = padsForDeck(deck)[slot];
  if (!rec || !pad || rec.latch) return false;
  padOff(deck, pad, rec.wasOn);
  return true;
}

/** Drop any held state for a deck — focus moved, the board was re-bound, a device vanished. */
export function fxPadsClear(deckId: string): void {
  for (const k of [...heldPads.keys()]) if (k.startsWith(deckId)) heldPads.delete(k);
}

/** Fire an FX pad (keyboard/MIDI 1-8 in fx mode). `on` = key down (press), false = key up. */
export function fireFxPad(deck: Deck, slot: number, on: boolean): void {
  const pad = padsForDeck(deck)[slot];
  if (!pad) return;
  if (on) pad.on(deck);
  else pad.off?.(deck);
}

// ★ A SLOT IS NOT AN ADDRESS ANY MORE. Slot 3 means "the fourth device of the chain I am aimed
// at", so a recorded or relayed fxPad gesture replayed against a different focus fires a
// DIFFERENT effect. The wire form carries the chain with it — "<chainId>:<slot>" — and the
// receiver aims there for the duration of the gesture, then puts its focus back.
// ★ AND THE CHAIN TRAVELS BY NAME, NOT BY ID. Chain ids are per-deck sequence numbers ("c3");
// they do not survive a reload, let alone a second machine, so an id on the wire was always
// unknown on the far side and always fell back to the receiver's focus — firing the wrong
// effect. Chains DO sync now (DeckState.fxChains), and applyFxChainSnapshot rebuilds them by
// NAME for exactly this reason: "what a DJ recognises is the name". So the wire carries the
// name. The slot is still parsed off the LAST colon, so a name may contain one.
/** The wire name of the FX2 moves bank (a chain can never be called this: chain names are user
 *  text, upper-cased, and this is lower case with a sigil). */
const MOVES = "@moves";
export function fxPadArg(deck: Deck, slot: number): string {
  if (deck.padMode === "fx2") return `${MOVES}:${slot}`; // a move, not a device: same on any receiver
  // The chain the press ACTUALLY hit, not the one in focus — in FX2 those differ, and sending the
  // focused one would make the far side fire a different effect from the one you just heard.
  const c = deck.fxChain(deck.padChain);
  return `${!c || c.master ? "master" : c.name}:${slot}`;
}
/** Resolve a wire chain ref against this deck: master, then a live id (an older recording, or
 *  our own echo), then the name — which is what a synced chain actually matches on. */
export function chainRef(deck: Deck, ref: string) {
  return deck.fxChain(ref) ?? deck.fxChainList.find((c) => !c.master && c.name === ref);
}
export function fireFxPadArg(deck: Deck, arg: string | number, on: boolean): void {
  const raw = String(arg);
  const cut = raw.lastIndexOf(":");
  const slot = Number(cut >= 0 ? raw.slice(cut + 1) : raw);
  const chain = cut >= 0 ? raw.slice(0, cut) : "";
  if (chain === MOVES) {
    // A move fires on the receiver whatever bank it is sitting in.
    const pad = MOVE_PADS[slot];
    if (pad) on ? pad.on(deck) : pad.off?.(deck);
    return;
  }
  const back = deck.padChainOverride;
  const known = chain ? chainRef(deck, chain) : undefined;
  // Override rather than setFxFocus: the sender NAMED its chain, so that name must win over the
  // receiver's own padMode — and a co-DJ's press has no business moving what you are looking at.
  if (known) deck.padChainOverride = known.id;
  fireFxPad(deck, slot, on);
  if (known) deck.padChainOverride = back;
}

// Sync + replay over the board-agnostic gesture bus: a recorded/relayed "fxPad" gesture applies
// by slot index, so any pad added to FX_PADS above is covered with no protocol/applyIntent edit.
registerBoardAction("fxPad", (deck, phase, arg) => fireFxPadArg(deck, arg as string | number, phase !== "up"));
