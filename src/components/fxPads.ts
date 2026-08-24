import type { Deck, FxKind } from "@htl/audio";
import { registerBoardAction } from "@htl/board/boardActions";

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

// ★ THE BANK IS THE FOCUSED CHAIN. A pad is a pointer, slot i is device i of the chain you are
// looking at, and pad order IS processing order — the same list the strip renders and the graph
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
  const dev = (d: Deck) => d.fxChain(d.fxFocus)?.devices.find((x) => x.kind === kind);
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

/** The eight slots for a deck, right now: the focused chain's devices in order, padded out. A
 *  null slot is an empty slot — it is not a broken pad, it is a chain with room in it. */
export function padsForDeck(deck: Deck): (FxPadDef | null)[] {
  const chain = deck.fxChain(deck.fxFocus) ?? deck.fxChain("master");
  const pads: (FxPadDef | null)[] = (chain?.devices ?? []).map((d) => BY_KIND.get(d.kind) ?? genericPad(deck, d.kind, d.kind.toUpperCase()));
  while (pads.length < 8) pads.push(null);
  return pads.slice(0, 8);
}

// ★ ONE GESTURE, THREE TRANSPORTS. Touch, keyboard and MIDI all press the same pad, so the
// press/release rule lives HERE, once, keyed by deck+slot rather than by input device. That also
// makes the transports interoperable: press with a finger, release with the key, and the pad
// behaves — because the held state belongs to the PAD, not to whoever pushed it.
export const FX_HOLD_MS = 220; // the single tunable the whole gesture rests on — tune by ear
// What is physically down, and whether it was ALREADY lit when it went down — the second half is
// what makes a tap a TOGGLE rather than a one-way switch.
const heldPads = new Map<string, { t: number; wasOn: boolean }>();

/** Press. Engages if the pad is not already live, and reports whether it fired (so the caller can
 *  emit the intent) and which device to reveal. Repeats are ignored — a held keyboard key
 *  auto-repeats forty times a second, and each one would re-fire the throw. */
export function fxPadPress(deck: Deck, deckId: string, slot: number): { fired: boolean; repeat?: boolean; kind?: FxKind } {
  const pad = padsForDeck(deck)[slot];
  if (!pad) return { fired: false };
  const key = `${deckId}${slot}`;
  // Already down: a keyboard auto-repeat, forty a second. Say so, so the caller can skip the
  // reveal and the re-render too — swallowing only the throw still left the panel re-selecting
  // and the deck re-rendering for as long as the key was held.
  if (heldPads.has(key)) return { fired: false, repeat: true, kind: pad.kind };
  const wasOn = pad.active?.(deck) ?? false;
  heldPads.set(key, { t: performance.now(), wasOn });
  if (wasOn) return { fired: false, kind: pad.kind }; // already lit — the release decides its fate
  pad.on(deck);
  return { fired: true, kind: pad.kind };
}

/** Release. A quick tap LATCHES (leave it on); a hold past the threshold lets go — which is also
 *  how a lit pad is turned off: press it, hold, release. Returns whether it actually released. */
export function fxPadRelease(deck: Deck, deckId: string, slot: number): boolean {
  const key = `${deckId}${slot}`;
  const rec = heldPads.get(key);
  heldPads.delete(key);
  const pad = padsForDeck(deck)[slot];
  if (!rec || !pad) return false;
  // ★ A TAP IS A TOGGLE. Tapping a dark pad lights it; tapping a LIT one puts it out. It used to
  // only engage, so a second tap did nothing and the pad could be turned off only by holding it —
  // which reads as a stuck effect, because every other latching control in the world toggles.
  // A HOLD is momentary either way: past the threshold, release always lets go.
  const held = performance.now() - rec.t >= FX_HOLD_MS;
  if (!held && !rec.wasOn) return false; // quick tap that turned it on — leave it latched
  pad.off?.(deck);
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
// ⚠ Chain ids are per deck and per machine, and chains do NOT sync yet: across devices the id
// will usually be unknown, and this falls back to the receiver's own focus. That is the same
// divergence as before, no worse — but it is not fixed until chains themselves sync.
export function fxPadArg(deck: Deck, slot: number): string {
  return `${deck.fxFocus}:${slot}`;
}
export function fireFxPadArg(deck: Deck, arg: string | number, on: boolean): void {
  const raw = String(arg);
  const cut = raw.lastIndexOf(":");
  const slot = Number(cut >= 0 ? raw.slice(cut + 1) : raw);
  const chain = cut >= 0 ? raw.slice(0, cut) : "";
  const back = deck.fxFocus;
  const known = chain && deck.fxChain(chain);
  if (known) deck.setFxFocus(chain);
  fireFxPad(deck, slot, on);
  if (known) deck.setFxFocus(back);
}

// Sync + replay over the board-agnostic gesture bus: a recorded/relayed "fxPad" gesture applies
// by slot index, so any pad added to FX_PADS above is covered with no protocol/applyIntent edit.
registerBoardAction("fxPad", (deck, phase, arg) => fireFxPadArg(deck, arg as string | number, phase !== "up"));
