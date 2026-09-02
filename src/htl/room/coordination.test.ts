import { describe, expect, it } from "vitest";
import { Session, slotOf } from "./roomSim";
import { fxBypassIntent, fxParamIntent, fxRackIntent } from "./fxWire";
import { SmartFader } from "../automix/smartFader";
import type { Intent } from "./protocol";

// MULTI-DEVICE COORDINATION. One rule, asked of every gesture: after it, do both devices hold the
// same state? Everything below is that question with different nouns.
//
// See roomSim.ts for what is real (the apply path, the board registry) and what is modelled (the
// deck, and specifically its FX address space).

/** Both devices start from the same board — a session that has synced its snapshot. */
function twoDecksWithChains() {
  const s = new Session("laptop", "phone");
  s.each((d) => {
    const deck = d.engine.deck("A");
    const drums = deck.addChain("Drums", 0b0001);
    deck.addDevice(drums.id, "gate");
    deck.addDevice(drums.id, "crush");
    deck.addDevice("master", "eq");
    deck.addDevice("master", "delay");
    deck.addDevice("master", "reverb");
  });
  return s;
}

const converged = (s: Session) => {
  const [a, ...rest] = s.devices.map((d) => d.engine.snapshot());
  for (const other of rest) expect(other).toEqual(a);
};

describe("the plain controls still round-trip", () => {
  it("moves the same EQ band, filter, tempo and crossfader on both devices", () => {
    const s = new Session("laptop", "phone");
    s.host.emit({ kind: "control", deck: "A", param: "eqLow", value: -12 });
    s.host.emit({ kind: "control", deck: "B", param: "filter", value: 0.4 });
    s.guest.emit({ kind: "control", deck: "A", param: "tempo", value: 128 });
    s.guest.emit({ kind: "crossfade", value: -0.5 });
    expect(s.host.engine.deck("A").eq.eqLow).toBe(-12);
    expect(s.guest.engine.deck("A").eq.eqLow).toBe(-12);
    expect(s.host.engine.crossfade).toBe(-0.5);
    converged(s);
  });

  it("round-trips loops, hot cues, stems and transport", () => {
    const s = new Session("laptop", "phone");
    const moves: Intent[] = [
      { kind: "transport", deck: "A", action: "play" },
      { kind: "loop", deck: "A", action: "beat", beats: 4 },
      { kind: "hotcue", deck: "A", slot: 2, action: "press" },
      { kind: "stemGain", deck: "A", stem: "drums", value: 0.5 },
      { kind: "stem", deck: "A", stem: "vocals", on: false },
      { kind: "skip", deck: "B", beats: 8 },
      { kind: "loopBounds", deck: "B", start: 1, end: 5, active: true },
    ];
    for (const m of moves) s.host.emit(m);
    converged(s);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE FX RACK. `slot` is an index into the deck's FLAT device list, and since stem chains landed
// that list is `chains.flatMap(devices)` — stem chains first, master last. An index is only
// meaningful against the list it was computed from.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("FX rack — addressing a device across devices", () => {
  it("agrees on which device a slot names when the racks match", () => {
    const s = twoDecksWithChains();
    const slot = slotOf(s.host.engine.deck("A"), "Master", "delay");
    expect(s.guest.engine.deck("A").addrAt(slot)).toEqual({ chain: "Master", kind: "delay" });
  });

  it("★ moves the SAME effect when one device has an extra stem chain", () => {
    const s = twoDecksWithChains();
    // The laptop adds a second stem chain. Nothing in the protocol tells the phone about it:
    // fxRack carries the MASTER chain only, and chains ride the full session snapshot, which is
    // republished on a join or a load — not on a chain add.
    const bass = s.host.engine.deck("A").addChain("Bass", 0b0010);
    s.host.engine.deck("A").addDevice(bass.id, "sat");

    // Now the DJ turns the master reverb's mix on the laptop.
    const slot = slotOf(s.host.engine.deck("A"), "Master", "reverb");
    s.host.emit(fxParamIntent(s.host.engine.deck("A"), "A", slot, "mix", 0.8));

    // The phone holds five devices, so the laptop's slot 5 names NOTHING there — which is the
    // whole point: the index is not the address. What must be true is the outcome.
    const phone = s.guest.engine.deck("A");
    expect(phone.deviceAt("Master", "reverb")!.params.mix).toBe(0.8);
    // …and nothing else moved. A wrong-device apply is the failure this is really guarding.
    expect(phone.deviceAt("Drums", "gate")!.params).toEqual({});
    expect(phone.deviceAt("Drums", "crush")!.params).toEqual({});
    expect(phone.deviceAt("Master", "delay")!.params).toEqual({});
  });

  it("★ a stem-chain device is reachable at all", () => {
    const s = twoDecksWithChains();
    const slot = slotOf(s.host.engine.deck("A"), "Drums", "crush");
    s.host.emit(fxParamIntent(s.host.engine.deck("A"), "A", slot, "bits", 6));
    expect(s.guest.engine.deck("A").deviceAt("Drums", "crush")!.params.bits).toBe(6);
    converged(s);
  });

  it("★ bypasses the device the sender named, or none at all", () => {
    const s = twoDecksWithChains();
    const bass = s.host.engine.deck("A").addChain("Bass", 0b0010);
    s.host.engine.deck("A").addDevice(bass.id, "sat");
    const slot = slotOf(s.host.engine.deck("A"), "Drums", "gate");
    s.host.emit(fxBypassIntent(s.host.engine.deck("A"), "A", slot, true));
    expect(s.guest.engine.deck("A").deviceAt("Drums", "gate")!.bypassed).toBe(true);
    expect(s.guest.engine.deck("A").allDevices.filter((d) => d.bypassed)).toHaveLength(1);
  });

  it("a device the far side does not have is DROPPED, never applied to a neighbour", () => {
    const s = twoDecksWithChains();
    const bass = s.host.engine.deck("A").addChain("Bass", 0b0010);
    s.host.engine.deck("A").addDevice(bass.id, "sat");
    const slot = slotOf(s.host.engine.deck("A"), "Bass", "sat");
    s.host.emit(fxParamIntent(s.host.engine.deck("A"), "A", slot, "drive", 0.9));
    // The phone has no Bass chain yet. Nothing on it may have moved.
    for (const d of s.guest.engine.deck("A").allDevices) expect(d.params).toEqual({});
  });

  it("an OLD peer's slot-only message still applies the old way", () => {
    const s = twoDecksWithChains();
    const slot = slotOf(s.host.engine.deck("A"), "Master", "delay");
    s.host.emit({ kind: "fxParam", deck: "A", slot, param: "time", value: 0.25 }); // no chain/fx
    expect(s.guest.engine.deck("A").deviceAt("Master", "delay")!.params.time).toBe(0.25);
    converged(s);
  });

  it("★ a chain rename / stem change / new chain reaches the other device", () => {
    const s = twoDecksWithChains();
    const deck = s.host.engine.deck("A");
    deck.chains.find((c) => c.name === "Drums")!.name = "PERC";
    deck.chains.find((c) => c.name === "PERC")!.stems = 0b0011;
    const bass = deck.addChain("Bass", 0b0010);
    deck.addDevice(bass.id, "sat");
    s.host.emit(fxRackIntent(deck, "A"));
    const phone = s.guest.engine.deck("A");
    expect(phone.chains.map((c) => c.name)).toEqual(["PERC", "Bass", "Master"]);
    expect(phone.deviceAt("Bass", "sat")).toBeDefined();
    converged(s);
  });

  it("★ a preset applied to a STEM-chain device arrives", () => {
    const s = twoDecksWithChains();
    const deck = s.host.engine.deck("A");
    // What applyPreset does: write the params locally, then syncDevice → broadcastRack.
    Object.assign(deck.deviceAt("Drums", "gate")!.params, { rate: 0.25, duty: 0.6, shape: 2 });
    s.host.emit(fxRackIntent(deck, "A"));
    expect(s.guest.engine.deck("A").deviceAt("Drums", "gate")!.params).toEqual({ rate: 0.25, duty: 0.6, shape: 2 });
  });

  it("★ an unchanged rack is written in place, not torn down and rebuilt", () => {
    const s = twoDecksWithChains();
    const deck = s.host.engine.deck("A");
    s.guest.engine.deck("A").chainRebuilds = 0;
    // A master-side preset pick broadcasts the whole rack; the far side's stem chains are
    // identical, so rebuilding them would destroy live audio for nothing.
    Object.assign(deck.deviceAt("Master", "reverb")!.params, { decay: 0.7 });
    s.host.emit(fxRackIntent(deck, "A"));
    expect(s.guest.engine.deck("A").chainRebuilds).toBe(0);
    expect(s.guest.engine.deck("A").deviceAt("Master", "reverb")!.params.decay).toBe(0.7);
  });

  it("★ fxRack does not silently delete the stem chains it never carried", () => {
    const s = twoDecksWithChains();
    // The laptop adds a device to the master chain and broadcasts the rack, as FxStrip does.
    s.host.engine.deck("A").addDevice("master", "mod");
    s.host.emit(fxRackIntent(s.host.engine.deck("A"), "A"));
    // The phone's Drums chain must survive — and the master must gain the new device.
    expect(s.guest.engine.deck("A").deviceAt("Drums", "gate")).toBeDefined();
    expect(s.guest.engine.deck("A").deviceAt("Master", "mod")).toBeDefined();
    converged(s);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SMART FADER. A crossfader-driven transition: it morphs tempo, swaps the bass EQ and moves the
// crossfader together. The question is whether any of that reaches the other device.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("Smart Fader — an automated transition on a shared board", () => {
  // The REAL SmartFader, driven against the simulator. The cast is deliberate and is the point:
  // SmartFader only ever asks the engine for tempo, EQ, transport, sync role and beatgrids, all of
  // which FakeEngine holds — so this exercises the actual transition code, not a re-description of
  // it. (An earlier version of this test hand-rolled the moves; it passed against a fixed bug and
  // would have kept passing if the real code had changed underneath it.)
  function armedSession() {
    const s = new Session("laptop", "phone");
    s.each((d) => {
      d.engine.deck("A").beatgrid = { bpm: 124 };
      d.engine.deck("B").beatgrid = { bpm: 128 };
    });
    s.host.engine.deck("A").playing = true;
    s.guest.engine.deck("A").playing = true;
    const fader = new SmartFader(s.host.engine as unknown as ConstructorParameters<typeof SmartFader>[0]);
    fader.setEmitter((intent) => s.host.emit(intent, { local: false })); // the deck moves already happened locally
    return { s, fader };
  }

  it("★ arms, and the far side knows it — key-lock pinned on BOTH decks", () => {
    const { s, fader } = armedSession();
    expect(fader.arm(-1)).toBe(true);
    expect(s.guest.engine.deck("A").keylockPinnedOff).toBe(true);
    expect(s.guest.engine.deck("B").keylockPinnedOff).toBe(true);
  });

  it("★ leaves both devices holding the same board across a whole throw", () => {
    const { s, fader } = armedSession();
    fader.arm(-1);
    for (const cf of [-1, -0.5, 0, 0.5, 0.999]) {
      fader.onCrossfade(cf);
      s.host.emit({ kind: "crossfade", value: cf }, { local: false }); // dragCrossfade's own emit
      s.host.engine.setCrossfade(cf);
    }
    converged(s);
  });

  it("★ the bass swap and the tempo morph actually arrive", () => {
    const { s, fader } = armedSession();
    fader.arm(-1);
    fader.onCrossfade(0); // mid-throw: the bass has handed over, the tempo has moved
    const hostA = s.host.engine.deck("A");
    const phoneA = s.guest.engine.deck("A");
    expect(hostA.eq.eqLow).toBeLessThan(0); // the live deck's bass is being cut
    expect(phoneA.eq.eqLow).toBe(hostA.eq.eqLow);
    expect(phoneA.tempo).toBe(hostA.tempo);
    expect(phoneA.tempo).not.toBe(0);
  });

  it("★ disarming returns BOTH devices to neutral, not just this one", () => {
    const { s, fader } = armedSession();
    fader.arm(-1);
    fader.onCrossfade(0);
    fader.disarm();
    for (const d of s.devices) {
      expect(d.engine.deck("A").eq.eqLow).toBe(0);
      expect(d.engine.deck("A").tempo).toBe(0);
      expect(d.engine.deck("A").keylockPinnedOff).toBe(false);
    }
    converged(s);
  });
});
