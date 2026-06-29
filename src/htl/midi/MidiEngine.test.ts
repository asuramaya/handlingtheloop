import { describe, it, expect, vi, afterEach } from "vitest";
import { MidiEngine } from "./MidiEngine";
import type { MidiEvent } from "./types";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// L2 byte-replay harness — CI for the CONTROLLER-FACING layer without the controller.
//
// A DDJ-FLX4 is a deterministic byte source. This drives the REAL MidiEngine end-to-end — a fake
// MIDI port named "DDJ-FLX4" makes matchProfile select the real built-in profile, buildIndex wires
// the real bindings, and raw bytes fired through the port run the real decode + dispatch — then we
// assert the normalized MidiEvent. So it locks the PROFILE itself (the byte→event map in
// docs/ddj-flx4.md) against accidental edits, with no hardware.
//
// HONESTY BOUNDARY (unchanged): this proves the CODE honors the documented byte map. It does NOT
// prove the FLX4 actually EMITS these bytes — that's a one-time hardware fact (firmware/mode can
// remap; see htl-flx-hardware-pathology). The way to re-ground it without re-plugging each time is a
// golden CAPTURE: record real FLX4 bytes once via MidiDebug, commit them, replay them here.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const NOTE_A = 0x90, NOTE_B = 0x91, CC_A = 0xb0, CC_B = 0xb1; // FLX4 channels (ddj-flx4.ts)

const live: MidiEngine[] = [];
afterEach(() => {
  for (const e of live.splice(0)) e.stop(); // clear the Pioneer keep-alive interval
  vi.unstubAllGlobals();
});

// Stand up a MidiEngine bound to a fake "DDJ-FLX4" input, driven through the real start() path.
async function flx() {
  const events: MidiEvent[] = [];
  const input = { name: "DDJ-FLX4", id: "in", state: "connected", onmidimessage: null as null | ((e: { data: Uint8Array }) => void) };
  const access = { inputs: new Map([["in", input]]), outputs: new Map(), onstatechange: null };
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", { requestMIDIAccess: async () => access });
  const engine = new MidiEngine({ onEvent: (e) => events.push(e), onStatus: () => {}, getLearn: () => ({}) });
  live.push(engine);
  await engine.start(); // → matchProfile("DDJ-FLX4") → buildIndex → port.onmidimessage wired
  expect(input.onmidimessage, "the fake FLX4 port should be wired as the chosen input").toBeTypeOf("function");
  return { events, send: (...bytes: number[]) => input.onmidimessage!({ data: new Uint8Array(bytes) }) };
}

describe("MidiEngine — FLX4 jog layers decode through the real profile", () => {
  it("jog TOUCH (note 0x36) → jogTouch down/up, per deck", async () => {
    const { events, send } = await flx();
    send(NOTE_A, 0x36, 0x7f); // touch on
    send(NOTE_A, 0x36, 0x00); // touch off (note-on vel 0)
    send(NOTE_B, 0x36, 0x7f);
    expect(events).toEqual([
      { type: "jogTouch", deck: "A", down: true },
      { type: "jogTouch", deck: "A", down: false },
      { type: "jogTouch", deck: "B", down: true },
    ]);
  });

  it("vinyl SCRATCH stream (CC 0x22) → jogTurn scratch:true, signed (val−64)", async () => {
    const { events, send } = await flx();
    send(CC_A, 0x22, 0x41); // 65 → +1
    send(CC_A, 0x22, 0x3f); // 63 → −1
    send(CC_B, 0x22, 0x44); // 68 → +4 on deck B
    expect(events).toEqual([
      { type: "jogTurn", deck: "A", delta: 1, scratch: true },
      { type: "jogTurn", deck: "A", delta: -1, scratch: true },
      { type: "jogTurn", deck: "B", delta: 4, scratch: true },
    ]);
  });

  it("BEND stream (CC 0x23, vinyl-off top turn) → jogTurn scratch:false — the OTHER jog layer", async () => {
    const { events, send } = await flx();
    send(CC_A, 0x23, 0x42); // +2
    expect(events).toEqual([{ type: "jogTurn", deck: "A", delta: 2, scratch: false }]);
  });

  it("OUTER RING (CC 0x21) → jogBend, with the ±1 rest-jitter deadzone", async () => {
    const { events, send } = await flx();
    send(CC_A, 0x21, 0x41); // +1 → swallowed by the deadzone (|delta| must exceed 1)
    send(CC_A, 0x21, 0x42); // +2 → passes
    send(CC_A, 0x21, 0x3d); // −3 → passes
    expect(events).toEqual([
      { type: "jogBend", deck: "A", delta: 2 },
      { type: "jogBend", deck: "A", delta: -3 },
    ]);
  });

  it("SHIFT + jog (CC 0x29) → jogSearch", async () => {
    const { events, send } = await flx();
    send(CC_A, 0x29, 0x43); // +3
    expect(events).toEqual([{ type: "jogSearch", deck: "A", delta: 3 }]);
  });

  it("a centered jog value (0x40) emits nothing (no spurious motion at rest)", async () => {
    const { events, send } = await flx();
    send(CC_A, 0x22, 0x40); // exactly 64 → delta 0 → suppressed
    expect(events).toEqual([]);
  });
});

describe("MidiEngine — FLX4 non-jog controls (profile breadth)", () => {
  it("PLAY / CUE notes → button events, per deck", async () => {
    const { events, send } = await flx();
    send(NOTE_A, 0x0b, 0x7f); // PLAY
    send(NOTE_B, 0x0c, 0x7f); // CUE on deck B
    expect(events).toContainEqual(expect.objectContaining({ type: "button", action: "play", deck: "A", pressed: true, shift: false }));
    expect(events).toContainEqual(expect.objectContaining({ type: "button", action: "cue", deck: "B", pressed: true, shift: false }));
  });

  it("an UNMAPPED address emits nothing (the profile only speaks what it declares)", async () => {
    const { events, send } = await flx();
    send(CC_A, 0x7e, 0x40); // a CC the FLX4 profile doesn't bind
    expect(events).toEqual([]);
  });
});
