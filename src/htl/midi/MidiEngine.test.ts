import { readFileSync } from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";
import { MidiEngine, type MidiCapture } from "./MidiEngine";
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

  it("OUTER RING (CC 0x21) → jogBend: every tick at once, including a micro back-and-forth of single ±1s", async () => {
    const { events, send } = await flx();
    send(CC_A, 0x21, 0x41); // +1
    send(CC_A, 0x21, 0x3f); // −1 (reverses: a micro back-and-forth, not jitter to drop)
    send(CC_A, 0x21, 0x41); // +1
    send(CC_A, 0x21, 0x3d); // −3
    expect(events).toEqual([
      { type: "jogBend", deck: "A", delta: 1 },
      { type: "jogBend", deck: "A", delta: -1 },
      { type: "jogBend", deck: "A", delta: 1 },
      { type: "jogBend", deck: "A", delta: -3 },
    ]);
  });

  it("SHIFT+SYNC (0x60, shift fixed OFF) → keyMatch with shift:false and shiftFixed, though SHIFT is held", async () => {
    const { events, send } = await flx();
    send(NOTE_B, 0x3f, 0x7f); // SHIFT B down
    send(NOTE_B, 0x60, 0x7f); // SHIFT+SYNC
    expect(events).toContainEqual(expect.objectContaining({ type: "button", action: "keyMatch", deck: "B", pressed: true, shift: false, shiftFixed: true }));
  });

  it("OUTER RING on the real 2026-11-02 capture: all of the ring's travel survives (the old deadzone kept ~40%)", async () => {
    const cap = JSON.parse(readFileSync(new URL("./fixtures/flx4-jog-real-2026-11-02.json", import.meta.url), "utf8")) as MidiCapture;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    try {
      const { events, send } = await flx();
      const t0 = performance.now() - cap.events[0].t;
      let raw = 0;
      for (const e of cap.events) {
        const due = t0 + e.t - performance.now();
        if (due > 0) vi.advanceTimersByTime(due);
        if ((e.s & 0xf0) === 0xb0 && e.d1 === 0x21) raw += Math.abs(e.d2 - 64);
        send(e.s, e.d1, e.d2);
      }
      const got = events.reduce((a, ev) => a + (ev.type === "jogBend" ? Math.abs(ev.delta) : 0), 0);
      expect(raw).toBeGreaterThan(1000);
      expect(got / raw).toBeGreaterThan(0.99);
    } finally {
      vi.useRealTimers();
    }
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

// The full loop: a golden CAPTURE (recorded via MidiDebug ▸ ● Capture, exported as JSON) replayed
// through the engine. This synthetic fixture proves the capture FORMAT round-trips end-to-end; a
// real hardware capture dropped in fixtures/ re-grounds the byte map the same way, in CI.
describe("MidiEngine — replay a captured fixture", () => {
  it("decodes a recorded FLX4 jog gesture back to the expected event stream", async () => {
    const cap = JSON.parse(readFileSync(new URL("./fixtures/flx4-jog-sample.json", import.meta.url), "utf8")) as MidiCapture;
    const { events, send } = await flx();
    for (const e of cap.events) send(e.s, e.d1, e.d2);
    expect(events).toEqual([
      { type: "jogTouch", deck: "A", down: true },
      { type: "jogTurn", deck: "A", delta: 2, scratch: true },
      { type: "jogTurn", deck: "A", delta: 3, scratch: true },
      { type: "jogTurn", deck: "A", delta: -2, scratch: true },
      { type: "jogTouch", deck: "A", down: false },
      expect.objectContaining({ type: "button", action: "play", deck: "A", pressed: true }),
    ]);
  });
});

describe("MidiEngine — FLX4 channel level meters", () => {
  it("setMeter drives CC 0x02 on each deck's channel, clamped, and only on change", async () => {
    const sent: number[][] = [];
    const input = { name: "DDJ-FLX4", id: "in", state: "connected", onmidimessage: null };
    const output = { name: "DDJ-FLX4", id: "out", state: "connected", send: (b: number[]) => sent.push([...b]) };
    const access = { inputs: new Map([["in", input]]), outputs: new Map([["out", output]]), onstatechange: null };
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", { requestMIDIAccess: async () => access });
    const engine = new MidiEngine({ onEvent: () => {}, onStatus: () => {}, getLearn: () => ({}) });
    live.push(engine);
    await engine.start();
    sent.length = 0; // drop the handshake / keep-alive
    engine.setMeter("A", 64);
    engine.setMeter("A", 64.2); // same LED step: nothing sent
    engine.setMeter("B", 300); // clamped
    engine.setMeter("A", -5); // clamped
    const meters = sent.filter((b) => (b[0] === 0xb0 || b[0] === 0xb1) && b[1] === 0x02);
    expect(meters).toEqual([
      [0xb0, 0x02, 64],
      [0xb1, 0x02, 127],
      [0xb0, 0x02, 0],
    ]);
  });
});

// ★ THE SMART CFX LAMP, LIT (operator, 2026-11-06). Lit, Pioneer's hardware Smart CFX makes the
// COLOR knob ALSO send TRIM. The fixture is the real capture: a COLOR sweep (52.8–55.6 s) whose
// echoes land on B0 04/24, then a TRIM-only sweep (55.8–59.2 s). Replayed on its own clock.
describe("MidiEngine — FLX4 SMART CFX lamp echo filter (real capture)", () => {
  async function flxOut() {
    const events: { e: MidiEvent; t: number }[] = [];
    const sent: number[][] = [];
    const input = { name: "DDJ-FLX4", id: "in", state: "connected", onmidimessage: null as null | ((e: { data: Uint8Array }) => void) };
    const output = { name: "DDJ-FLX4", id: "out", state: "connected", send: (b: number[]) => sent.push([...b]) };
    const access = { inputs: new Map([["in", input]]), outputs: new Map([["out", output]]), onstatechange: null };
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", { requestMIDIAccess: async () => access });
    const engine = new MidiEngine({ onEvent: (e) => events.push({ e, t: performance.now() }), onStatus: () => {}, getLearn: () => ({}) });
    live.push(engine);
    await engine.start();
    return { engine, events, sent, send: (...b: number[]) => input.onmidimessage!({ data: new Uint8Array(b) }) };
  }
  const cap = JSON.parse(readFileSync(new URL("./fixtures/flx4-cfx-lamp-lit-2026-11-06.json", import.meta.url), "utf8")) as MidiCapture;
  async function replay(lit: boolean) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    try {
      const rig = await flxOut();
      rig.engine.setEchoLamp(lit);
      vi.advanceTimersByTime(2000); // past the post-change grace window
      const t0 = performance.now() - cap.events[0].t;
      for (const e of cap.events) {
        const due = t0 + e.t - performance.now();
        if (due > 0) vi.advanceTimersByTime(due);
        rig.send(e.s, e.d1, e.d2);
      }
      vi.advanceTimersByTime(100); // flush anything still held
      const trim = rig.events
        .filter(({ e }) => e.type === "fader" && e.target === "trim" && e.deck === "A")
        .map(({ e, t }) => ({ t: t - t0, v: (e as { value: number }).value }));
      return { ...rig, trim };
    } finally {
      vi.useRealTimers();
    }
  }
  const inColor = (t: number) => t >= 52_800 && t <= 55_650;
  const inTrim = (t: number) => t >= 55_800;

  it("lit: the COLOR sweep's trim echoes are dropped; the real TRIM sweep still drives trim end to end", async () => {
    const { trim, sent } = await replay(true);
    expect(sent).toContainEqual([0x96, 0x00, 0x7f]);
    expect(trim.filter((x) => inColor(x.t))).toEqual([]);
    const real = trim.filter((x) => inTrim(x.t)).map((x) => x.v);
    expect(real.length).toBeGreaterThan(100);
    expect(Math.min(...real)).toBeLessThan(0.02);
    expect(Math.max(...real)).toBeGreaterThan(0.98);
  });

  it("dark: the same bytes DO move trim during the COLOR sweep (so the filter is what removes them)", async () => {
    const { trim, sent } = await replay(false);
    expect(sent).not.toContainEqual([0x96, 0x00, 0x7f]);
    expect(trim.filter((x) => inColor(x.t)).length).toBeGreaterThan(20);
  });

  it("setEchoLamp is diffed and resent after a reconnect", async () => {
    const { engine, sent } = await flxOut();
    sent.length = 0;
    engine.setEchoLamp(true);
    engine.setEchoLamp(true);
    engine.setEchoLamp(false);
    expect(sent.filter((b) => b[0] === 0x96 && b[1] === 0x00)).toEqual([[0x96, 0x00, 0x7f], [0x96, 0x00, 0x00]]);
  });

  it("after a SMART CFX press/release the lamp state is re-asserted (the firmware flips the lamp itself)", async () => {
    const { engine, sent, send } = await flxOut();
    engine.setEchoLamp(true);
    sent.length = 0;
    send(0x96, 0x00, 0x7f); // press
    send(0x96, 0x00, 0x00); // release
    engine.setEchoLamp(true);
    engine.setEchoLamp(true);
    expect(sent.filter((b) => b[0] === 0x96 && b[1] === 0x00)).toEqual([[0x96, 0x00, 0x7f], [0x96, 0x00, 0x7f]]);
  });
});

describe("MidiEngine — FLX4 second hot-cue bank", () => {
  it("SHIFT + HOT CUE (0x69) → padModeCue with shift (App: CUE 2, hot cues 9–16)", async () => {
    const { events, send } = await flx();
    send(NOTE_A, 0x3f, 0x7f); // SHIFT A
    send(NOTE_A, 0x69, 0x7f); // shifted HOT CUE
    expect(events).toContainEqual(expect.objectContaining({ type: "button", action: "padModeCue", deck: "A", pressed: true, shift: true }));
  });
});

describe("MidiEngine — pad-mode lamp blinks for a shifted layer", () => {
  it("lit steady on the base bank; blinking on its shifted peer (CUE2 / FX2 / ROLL / GLOBAL)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(0);
      const sent: number[][] = [];
      const input = { name: "DDJ-FLX4", id: "in", state: "connected", onmidimessage: null };
      const output = { name: "DDJ-FLX4", id: "out", state: "connected", send: (b: number[]) => sent.push([...b]) };
      const access = { inputs: new Map([["in", input]]), outputs: new Map([["out", output]]), onstatechange: null };
      vi.stubGlobal("isSecureContext", true);
      vi.stubGlobal("navigator", { requestMIDIAccess: async () => access });
      const engine = new MidiEngine({ onEvent: () => {}, onStatus: () => {}, getLearn: () => ({}) });
      live.push(engine);
      await engine.start();
      const fb = { play: false, cue: false, sync: false, loop: false, loopIn: false, loopOut: false, cuePfl: false, hotcues: Array(8).fill(false), padMode: "cue" as const };
      const cueLamp = () => sent.filter((b) => b[0] === 0x90 && b[1] === 0x1b).map((b) => b[2]);
      engine.setFeedback("A", fb); // base bank: lit
      vi.setSystemTime(310);
      engine.setFeedback("A", fb); // still lit, nothing re-sent
      expect(cueLamp()).toEqual([0x7f]);
      engine.setFeedback("A", { ...fb, padModeAlt: true }); // CUE2: phase 1 → off
      vi.setSystemTime(620);
      engine.setFeedback("A", { ...fb, padModeAlt: true }); // phase 2 → on
      vi.setSystemTime(700);
      engine.setFeedback("A", { ...fb, padModeAlt: true }); // same phase: nothing
      engine.setFeedback("A", fb); // back to CUE: steady on, the shifted lamp dark
      expect(cueLamp()).toEqual([0x7f, 0x20, 0x7f, 0x7f]); // the low half is DIM (0x20), not dark
      // the shifted lamp (0x69, the note SHIFT+HOT CUE sends) blinks in step, and goes dark on leaving
      expect(sent.filter((b) => b[0] === 0x90 && b[1] === 0x69).map((b) => b[2])).toEqual([0x20, 0x7f, 0x00]);
    } finally {
      vi.useRealTimers();
    }
  });
});
