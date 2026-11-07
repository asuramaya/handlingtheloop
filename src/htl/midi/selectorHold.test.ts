import { afterEach, describe, expect, it, vi } from "vitest";
import { MidiEngine } from "./MidiEngine";
import type { MidiEvent } from "./types";

// Operator, 2026-11-03: board-only library navigation had "no way to exit it" ("maybe a hold or
// double press?"). A tap on the browse encoder still acts on the press (tracks ↔ sources); HOLD it
// and the library closes. Drives the real MidiEngine through a fake "DDJ-FLX4" port, as
// MidiEngine.test.ts does.

const live: MidiEngine[] = [];
afterEach(() => {
  for (const e of live.splice(0)) e.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function flx() {
  const events: MidiEvent[] = [];
  const input = { name: "DDJ-FLX4", id: "in", state: "connected", onmidimessage: null as null | ((e: { data: Uint8Array }) => void) };
  const access = { inputs: new Map([["in", input]]), outputs: new Map(), onstatechange: null };
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", { requestMIDIAccess: async () => access });
  const engine = new MidiEngine({ onEvent: (e) => events.push(e), onStatus: () => {}, getLearn: () => ({}) });
  live.push(engine);
  await engine.start();
  return { events, send: (...bytes: number[]) => input.onmidimessage!({ data: new Uint8Array(bytes) }) };
}

const sel = (events: MidiEvent[]) => events.filter((e) => e.type === "selector" || e.type === "selectorHold");

describe("FLX4 browse encoder press: tap vs hold", () => {
  it("a tap sends selector only", async () => {
    const { events, send } = await flx();
    vi.useFakeTimers();
    send(0x96, 0x41, 0x7f); // press
    vi.advanceTimersByTime(120);
    send(0x96, 0x41, 0x00); // release (note-on, velocity 0)
    vi.advanceTimersByTime(MidiEngine.SELECTOR_HOLD_MS + 100);
    expect(sel(events)).toEqual([{ type: "selector" }]);
  });

  it("a hold also sends selectorHold, once", async () => {
    const { events, send } = await flx();
    vi.useFakeTimers();
    send(0x96, 0x41, 0x7f);
    vi.advanceTimersByTime(MidiEngine.SELECTOR_HOLD_MS + 50);
    send(0x96, 0x41, 0x00);
    vi.advanceTimersByTime(1000);
    expect(sel(events)).toEqual([{ type: "selector" }, { type: "selectorHold" }]);
  });
});
