// Web MIDI transport + decoder. Owns the MIDIAccess, port enumeration, hot-plug,
// the per-device keep-alive handshake, raw-byte decode (7-bit notes, 14-bit CC
// pairs, relative jog ticks), LED feedback, and MIDI-Learn capture. It is pure
// I/O: every decoded control becomes a normalized MidiEvent handed to `onEvent`,
// which the app routes into its existing action handlers + deck setters.

import { matchProfile } from "./profiles";
import type { ControlSpec, DeckId, DeckFeedback, DeviceProfile, LearnedBinding, MidiBinding, MidiEvent, MidiLearnMap, MidiStatus } from "./types";

// --- minimal Web MIDI typings (avoid depending on lib.dom having them) ---
interface MidiMessage {
  data: Uint8Array;
}
interface MidiPort {
  id: string;
  name: string | null;
  state: string;
  onmidimessage?: ((e: MidiMessage) => void) | null;
}
interface MidiOutput {
  send(data: number[] | Uint8Array): void;
}
interface MidiAccess {
  inputs: { values(): IterableIterator<MidiPort> };
  outputs: { values(): IterableIterator<MidiOutput & { name: string | null }> };
  onstatechange: ((e: { port: { type: string; state: string } }) => void) | null;
}
type RequestMIDIAccess = (opts?: { sysex?: boolean }) => Promise<MidiAccess>;

const addr = (status: number, data: number) => (status << 8) | data;

// OS loopback / virtual MIDI ports that aren't a real controller — skip them when
// auto-picking the device and when sending output (they echo back as fake input).
function isVirtualPort(name: string | null): boolean {
  if (!name) return false;
  return /midi through|through port|rtmidi|\biac\b|virtual/i.test(name);
}

interface IndexEntry {
  binding: MidiBinding;
  isLsb?: boolean; // for cc14: this address carries the LSB
  shiftOverride?: boolean; // dispatch with this explicit shift value (else use live SHIFT)
}

export interface MonMsg {
  status: number;
  d1: number;
  d2: number;
  seq: number;
}
// An OUTGOING message (LED feedback diff or a manual probe) for the debug panel.
export interface OutMsg {
  bytes: number[];
  seq: number;
}
const MON_MAX = 32;

export interface MidiEngineOptions {
  onEvent: (e: MidiEvent) => void;
  onStatus: (s: MidiStatus) => void;
  // The user's learned/custom bindings, layered OVER any matched built-in profile.
  getLearn: () => MidiLearnMap;
  // Fired with a captured raw address while in learn mode (see armLearn).
  onLearnCapture?: (cap: { status: number; data: number; type: "note" | "cc" | "cc14" }) => void;
}

export class MidiEngine {
  private access: MidiAccess | null = null;
  private outputs: (MidiOutput & { name: string | null })[] = [];
  private profile: DeviceProfile | null = null;
  private noteIndex = new Map<number, IndexEntry>();
  private ccIndex = new Map<number, IndexEntry>();
  private msb = new Map<number, number>(); // cc14 MSB store, keyed by addr(status,msbData)
  private lsb = new Map<number, number>();
  private shiftHeld: Record<DeckId, boolean> = { A: false, B: false }; // each deck's SHIFT button
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private learnArmed = false;
  private lastFb: Partial<Record<DeckId, DeckFeedback>> = {};
  private started = false;
  private starting = false; // a request is in flight (don't fire a second from the effect)
  // Last-attempt diagnostics for the Debug tab.
  private diag = { error: "—", permMidi: "?", permSysex: "?" };
  // Live MIDI monitor ring (newest last).
  private mon: MonMsg[] = [];
  private monSeq = 0;
  // Outgoing-message ring (LED feedback + manual probes) — the output side of the
  // monitor, so the debug panel can reverse-engineer a board's LED / RGB protocol.
  private outMon: OutMsg[] = [];
  private outSeq = 0;
  // Jog-tick cadence log (scratch CC arrival times + signed ticks) — instrumentation to
  // measure how bursty/sparse the hardware jog stream is vs a steady mouse (see jogCadence).
  private jogLog: { t: number; d: number }[] = [];
  // Last raw value per relative-encoder address → relative delta (see emitKnob).
  private lastAbs = new Map<number, number>();
  // Sub-step carry per encoder-action address → one action per detent (see dispatchCC).
  private stepAcc = new Map<number, number>();

  constructor(private opts: MidiEngineOptions) {}

  supported(): boolean {
    return typeof navigator !== "undefined" && typeof (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess === "function";
  }

  async start(): Promise<void> {
    if (this.started || this.starting) return;
    const nav = navigator as unknown as { requestMIDIAccess?: RequestMIDIAccess };
    if (!nav.requestMIDIAccess) {
      this.opts.onStatus({ state: "unsupported" });
      return;
    }
    // Bound to `navigator` — Web MIDI throws "Illegal invocation" if requestMIDIAccess
    // is called detached from its receiver.
    const req: RequestMIDIAccess = (opts) => nav.requestMIDIAccess!(opts);
    // Web MIDI is only available in a secure context. localhost/127.0.0.1 and HTTPS
    // qualify; a bare LAN IP (vite's "Network" URL, e.g. http://192.168.x.x:5173)
    // does NOT — requestMIDIAccess rejects with SecurityError and no prompt shows.
    if (typeof isSecureContext !== "undefined" && !isSecureContext) {
      this.opts.onStatus({ state: "denied", reason: "Not a secure context — open via http://localhost or HTTPS, not a LAN IP" });
      return;
    }
    // Call requestMIDIAccess FIRST, with NO await before it, so it runs inside the
    // click's user activation — Chrome only shows the permission prompt for a request
    // tied to a user gesture; one fired later from an effect is silently rejected.
    // SysEx is required for the Pioneer keep-alive; fall back to non-sysex so other
    // boards still work if the user declines the sysex prompt.
    this.starting = true;
    let access: MidiAccess;
    try {
      access = await req({ sysex: true });
    } catch (e1) {
      try {
        access = await req({ sysex: false });
      } catch (e2) {
        this.starting = false;
        // Now (no activation needed) ask the Permissions API WHY, for a precise hint.
        const err = (e2 ?? e1) as { name?: string; message?: string };
        const rawErr = err?.name ? `${err.name}: ${err.message ?? ""}`.trim() : "request rejected";
        let reason = rawErr;
        const perms = (navigator as unknown as { permissions?: { query(d: { name: string; sysex?: boolean }): Promise<{ state: string }> } }).permissions;
        const queryState = async (sysex: boolean) => {
          try {
            return (await perms?.query({ name: "midi", sysex }))?.state ?? "?";
          } catch {
            return "n/a";
          }
        };
        this.diag = { error: rawErr, permMidi: await queryState(false), permSysex: await queryState(true) };
        if (this.diag.permSysex === "denied" && this.diag.permMidi !== "denied") {
          reason = "SysEx blocked — the FLX4 needs it. Reset MIDI in Site settings and re-grant, allowing system-exclusive";
        } else if (this.diag.permMidi === "denied") {
          reason = "Blocked in Chrome — click the icon left of the URL → Site settings → MIDI → Allow, then reload";
        } else if (this.diag.permMidi === "prompt") {
          reason = "No prompt appeared — click Connect again (must be a direct click)";
        }
        console.warn(
          "[MIDI] requestMIDIAccess failed —",
          rawErr,
          "\n  secureContext:",
          typeof isSecureContext !== "undefined" ? isSecureContext : "?",
          "\n  crossOriginIsolated:",
          typeof crossOriginIsolated !== "undefined" ? crossOriginIsolated : "?",
          "\n  perm(midi):",
          this.diag.permMidi,
          "\n  perm(midi+sysex):",
          this.diag.permSysex,
        );
        this.opts.onStatus({ state: "denied", reason });
        return;
      }
    }
    this.starting = false;
    this.started = true;
    this.access = access;
    access.onstatechange = () => this.rescan();
    this.rescan();
  }

  stop(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
    if (this.access) {
      for (const input of this.access.inputs.values()) input.onmidimessage = null;
      this.access.onstatechange = null;
    }
    this.access = null;
    this.outputs = [];
    this.profile = null;
    this.started = false;
    this.starting = false;
    this.opts.onStatus({ state: "idle" });
  }

  // Re-enumerate ports (initial + on hot-plug), pick the controller, rebuild indices.
  private rescan(): void {
    if (!this.access) return;
    const inputs = Array.from(this.access.inputs.values());
    for (const input of inputs) input.onmidimessage = (e) => this.onMessage(e.data);
    // Pick the actual controller, not an OS virtual port. On Linux Chrome also
    // enumerates "Midi Through Port-0" (and apps add RtMidi/IAC ports) — picking the
    // first input would wrongly match the FLX4's real port as "generic". So: prefer an
    // input that matches a built-in profile; else the first real (non-virtual) port.
    let chosen: MidiPort | undefined;
    let profile: DeviceProfile | null = null;
    for (const input of inputs) {
      const p = matchProfile(input.name);
      if (p) {
        chosen = input;
        profile = p;
        break;
      }
    }
    if (!chosen) chosen = inputs.find((i) => !isVirtualPort(i.name)) ?? inputs[0];
    // Drive LED / keep-alive output to real ports only — sending to a "Midi Through"
    // port would loop our LED messages straight back in as fake button presses.
    this.outputs = Array.from(this.access.outputs.values()).filter((o) => !isVirtualPort(o.name));
    this.profile = profile;
    this.buildIndex();
    this.startKeepAlive();
    this.opts.onStatus({ state: "connected", device: chosen?.name ?? null, profile: profile?.name ?? null });
  }

  // Rebuild the address → binding lookup from the matched profile plus the user's
  // learned overrides (learned wins on a collision).
  private buildIndex(): void {
    this.noteIndex.clear();
    this.ccIndex.clear();
    // Pioneer performance pads send their SHIFTED variant on (pad status + 1):
    // 0x97→0x98 (deck A), 0x99→0x9a (deck B). Auto-register those so shift+pad works
    // for EVERY pad without mapping each shifted note — no manual shift bytes needed.
    const padStatuses = new Set(Object.values(this.profile?.padStatus ?? {}));
    const add = (b: MidiBinding) => {
      if (b.type === "note") {
        this.noteIndex.set(addr(b.status, b.data), { binding: b, shiftOverride: b.shift });
        if (padStatuses.has(b.status)) {
          this.noteIndex.set(addr(b.status + 1, b.data), { binding: b, shiftOverride: true });
        }
      } else if (b.type === "cc") {
        this.ccIndex.set(addr(b.status, b.data), { binding: b });
      } else {
        // cc14: MSB at data, LSB at data + 0x20
        this.ccIndex.set(addr(b.status, b.data), { binding: b, isLsb: false });
        this.ccIndex.set(addr(b.status, b.data + 0x20), { binding: b, isLsb: true });
      }
    };
    for (const b of this.profile?.bindings ?? []) add(b);
    const learn = this.opts.getLearn();
    for (const id of Object.keys(learn)) {
      const l: LearnedBinding = learn[id];
      add({ control: l.control, deck: l.deck, status: l.status, data: l.data, type: l.type });
    }
  }

  /** Call after the learn map changes so new bindings take effect live. */
  refreshLearn(): void {
    this.buildIndex();
  }

  /** Last-attempt diagnostics for the Debug tab. */
  info(): { error: string; permMidi: string; permSysex: string; crossOriginIsolated: boolean | string } {
    return { ...this.diag, crossOriginIsolated: typeof crossOriginIsolated !== "undefined" ? crossOriginIsolated : "?" };
  }

  /** True if the MIDI permission is already granted — so we can reconnect silently on
   *  load WITHOUT a prompt. When it's "prompt"/"denied" we wait for an explicit click. */
  async permissionGranted(): Promise<boolean> {
    try {
      const perms = (navigator as unknown as { permissions?: { query(d: { name: string }): Promise<{ state: string }> } }).permissions;
      return (await perms?.query({ name: "midi" }))?.state === "granted";
    } catch {
      return false;
    }
  }

  /** Recent raw MIDI messages (newest last) for the live monitor. */
  monitor(): MonMsg[] {
    return this.mon.slice();
  }

  /** Recent OUTGOING MIDI (LED feedback + manual probes) for the debug panel. */
  outMonitor(): OutMsg[] {
    return this.outMon.slice();
  }

  /** Jog-scratch cadence over the last `windowMs` — instrumentation for the scratch
   *  velocity model. A steady mouse reports ~1–8 ms apart; a hardware jog tends to be
   *  sparse + BURSTY (sub-1ms clusters then gaps), which a measured-interval velocity
   *  mis-reads. `burst` = fraction of inter-tick gaps under 1 ms, `maxGapMs` = the worst
   *  silence; both high = the case the alpha-beta filter is meant to smooth. */
  jogCadence(windowMs = 1500): { rate: number; count: number; medMs: number; p95Ms: number; maxGapMs: number; burst: number; avgTick: number } {
    const now = typeof performance !== "undefined" ? performance.now() : 0;
    const recent = this.jogLog.filter((e) => now - e.t <= windowMs);
    const n = recent.length;
    if (n < 2) return { rate: n, count: n, medMs: 0, p95Ms: 0, maxGapMs: 0, burst: 0, avgTick: n ? Math.abs(recent[0].d) : 0 };
    const gaps: number[] = [];
    let tickSum = 0;
    for (let i = 1; i < n; i++) gaps.push(recent[i].t - recent[i - 1].t);
    for (const e of recent) tickSum += Math.abs(e.d);
    const sorted = gaps.slice().sort((a, b) => a - b);
    const span = (recent[n - 1].t - recent[0].t) / 1000;
    const sub1 = gaps.filter((g) => g < 1).length;
    return {
      rate: span > 0 ? (n - 1) / span : 0,
      count: n,
      medMs: sorted[sorted.length >> 1],
      p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
      maxGapMs: sorted[sorted.length - 1],
      burst: gaps.length ? sub1 / gaps.length : 0,
      avgTick: tickSum / n,
    };
  }

  /** Names of the connected output ports we send to (empty = nothing to drive). */
  outputNames(): string[] {
    return this.outputs.map((o) => o.name ?? "output");
  }

  /** Send raw bytes out every connected port — the manual LED / RGB / SysEx probe
   *  behind the debug panel. Goes through send() so it's logged in outMonitor(). */
  sendRaw(bytes: number[]): void {
    this.send(bytes);
  }

  /** What a given note/CC currently maps to (for the monitor), or null if unmapped. */
  describe(status: number, d1: number): string | null {
    const entry = (status & 0xf0) === 0xb0 ? this.ccIndex.get(addr(status, d1)) : this.noteIndex.get(addr(status, d1));
    if (!entry) return null;
    const c = entry.binding.control;
    const deck = entry.binding.deck ? ` ${entry.binding.deck}` : "";
    const tag = entry.shiftOverride === true ? " ⇧" : entry.shiftOverride === false ? " ·no⇧" : "";
    const name =
      c.kind === "action" ? c.action : c.kind === "fader" ? c.target : c.kind === "beatjump" ? `beatjump ${c.beats}` : c.kind === "jogTurn" ? "jog turn" : c.kind === "jogBend" ? "jog bend" : c.kind === "jogSearch" ? "jog search" : c.kind === "jogTouch" ? "jog touch" : c.kind === "shift" ? "SHIFT" : c.kind === "focus" ? `focus ${c.deck}` : c.kind === "encoderAction" ? `step ${c.forward}` : c.kind;
    return `${name}${deck}${tag}`;
  }

  /** Arm capture of the next physical control (for MIDI-Learn). The next inbound
   *  message is reported via onLearnCapture and NOT dispatched as an event. */
  armLearn(on: boolean): void {
    this.learnArmed = on;
  }

  // --- inbound decode ---
  private onMessage(data: Uint8Array): void {
    if (data.length < 2) return;
    const status = data[0];
    const d1 = data[1];
    const d2 = data.length > 2 ? data[2] : 0;
    const hi = status & 0xf0;
    const isNote = hi === 0x90 || hi === 0x80;
    const isCC = hi === 0xb0;
    if (!isNote && !isCC) return; // ignore clock, sysex, aftertouch, etc.

    // Feed the live monitor (every note/CC, even unmapped) so the user can read off
    // a control's exact bytes while building a map.
    this.mon.push({ status, d1, d2, seq: ++this.monSeq });
    if (this.mon.length > MON_MAX) this.mon.shift();

    if (this.learnArmed) {
      this.learnArmed = false;
      const type = isNote ? "note" : "cc";
      this.opts.onLearnCapture?.({ status, data: d1, type });
      return;
    }

    if (isNote) {
      const pressed = hi === 0x90 && d2 > 0;
      this.dispatchNote(addr(status, d1), pressed, d2);
    } else {
      this.dispatchCC(status, d1, d2);
    }
  }

  private dispatchNote(key: number, pressed: boolean, velocity = 0): void {
    const entry = this.noteIndex.get(key);
    if (!entry) return;
    const b = entry.binding;
    const c = b.control;
    if (c.kind === "shift") {
      if (b.deck) this.shiftHeld[b.deck] = pressed;
      // Also drive HTL's GLOBAL shift mode (the on-screen latch + keyboard shift) so
      // pressing SHIFT visibly engages shift, not just the per-event flag above.
      this.opts.onEvent({ type: "shift", deck: b.deck ?? "A", down: pressed });
      return;
    }
    if (c.kind === "jogTouch") {
      if (b.deck) this.opts.onEvent({ type: "jogTouch", deck: b.deck, down: pressed });
      return;
    }
    if (!pressed) return; // remaining note controls act on press
    if (c.kind === "focus") {
      this.opts.onEvent({ type: "focus", deck: c.deck });
      return;
    }
    // An explicit shiftOverride wins (shifted-pad +1, or a force-on/off binding);
    // otherwise use the deck's live SHIFT state.
    const shift = entry.shiftOverride ?? (b.deck ? this.shiftHeld[b.deck] : false);
    if (c.kind === "action") {
      // deck omitted (focus-model board, e.g. Starrypad pads) → App drives the focused deck
      this.opts.onEvent({ type: "button", action: c.action, deck: b.deck, pressed: true, shift, velocity });
    } else if (c.kind === "beatjump" && b.deck) {
      this.opts.onEvent({ type: "beatjump", deck: b.deck, beats: c.beats, shift });
    } else if (c.kind === "load" && b.deck) {
      this.opts.onEvent({ type: "load", deck: b.deck });
    } else if (c.kind === "selector") {
      this.opts.onEvent({ type: "selector" });
    }
  }

  private dispatchCC(status: number, cc: number, val: number): void {
    const entry = this.ccIndex.get(addr(status, cc));
    if (!entry) return;
    const b = entry.binding;
    const c = b.control;

    if (b.type === "cc14") {
      const key = addr(b.status, b.data);
      if (entry.isLsb) this.lsb.set(key, val);
      else this.msb.set(key, val);
      const m = this.msb.get(key) ?? 0;
      const l = this.lsb.get(key) ?? 0;
      const v = (m << 7) | l; // 0..16383
      this.emitFader(c, b.deck, v / 16383);
      return;
    }

    // 7-bit CC
    if (c.kind === "focus") {
      // A CC button (pad-style boards send buttons as CC): act on press only.
      if (val >= 64) this.opts.onEvent({ type: "focus", deck: c.deck });
    } else if (c.kind === "shift") {
      // A CC shift — momentary (7F held / 00 released) OR a latching hardware toggle
      // (7F on / 00 off). Either way the down state IS val≥64. Deck omitted → focused.
      this.opts.onEvent({ type: "shift", deck: b.deck, down: val >= 64 });
    } else if (c.kind === "action") {
      // A CC button mapped to a transport/action — act on press. Deck omitted → focused.
      if (val >= 64) {
        const shift = b.deck ? this.shiftHeld[b.deck] : false;
        this.opts.onEvent({ type: "button", action: c.action, deck: b.deck, pressed: true, shift });
      }
    } else if (c.kind === "encoderAction") {
      this.dispatchEncoderAction(c, b.deck, addr(status, cc), val);
    } else if (c.kind === "fader") {
      if (c.relative) this.emitKnob(c, b.deck, addr(status, cc), val);
      else this.emitFader(c, b.deck, val / 127, c.pickup);
    } else if (c.kind === "jogTurn" && b.deck) {
      // Relative tick centred on 64; sign = direction, magnitude = speed. `scratch`
      // tells App which stream this is: the dedicated SCRATCH CC (vinyl mode) vs the
      // top-plate BEND CC (non-vinyl). App latches vinyl-mode + gates the grab off it.
      const delta = val - 64;
      if (delta !== 0) {
        if (typeof performance !== "undefined") {
          this.jogLog.push({ t: performance.now(), d: delta });
          if (this.jogLog.length > 600) this.jogLog.shift();
        }
        this.opts.onEvent({ type: "jogTurn", deck: b.deck, delta, scratch: c.scratch ?? false });
      }
    } else if (c.kind === "jogBend" && b.deck) {
      // Outer-ring / un-gripped rotation → a momentary pitch-bend nudge (App routes it).
      // The FLX4's outer ring idles on 0x40 but JITTERS ±1 (0x3F/0x41) at rest — touching
      // the unit (e.g. a SHIFT press) shakes out a stream of those. Deadzone ±1 so resting
      // noise never bends; a real ring turn easily clears it.
      const delta = val - 64;
      if (Math.abs(delta) > 1) this.opts.onEvent({ type: "jogBend", deck: b.deck, delta });
    } else if (c.kind === "jogSearch" && b.deck) {
      // SHIFT + platter (the FLX4 sends this on a distinct CC) → fast seek/scan.
      const delta = val - 64;
      if (delta !== 0) this.opts.onEvent({ type: "jogSearch", deck: b.deck, delta });
    } else if (c.kind === "browse") {
      // Pioneer rotary selector is a 2's-COMPLEMENT relative encoder: 0x01..0x3F = +1..+63
      // (forward), 0x7F..0x41 = -1..-63 (back, 0x7F = -1). It is NOT centred on 0x40 like
      // the jog platter — decoding it as val-64 leapt the browse cursor ±63 rows per detent
      // instead of stepping one at a time.
      const delta = val < 64 ? val : val - 128;
      if (delta !== 0) this.opts.onEvent({ type: "browse", delta });
    } else if (c.kind === "zoom") {
      const delta = val - 64;
      if (delta !== 0) this.opts.onEvent({ type: "zoom", deck: b.deck, delta });
    }
  }

  private emitFader(c: ControlSpec, deck: DeckId | undefined, v01: number, pickup?: boolean): void {
    if (c.kind !== "fader") return;
    const value = c.invert ? 1 - v01 : v01;
    this.opts.onEvent({ type: "fader", target: c.target, deck, value, pickup });
  }

  // Raw relative step for an encoder reported as ABSOLUTE 0..127 that WRAPS (127→0): a
  // plain (val−last) would be a ∓127 full-range LEAP, so treat 0..127 as CIRCULAR — a
  // wrap reads as the small step it really is. Returns 0 on first sample / a duplicate.
  // (Endless encoders that CLAMP and go silent at the rails can't be delta-tracked to
  // their extremes — those use `pickup` absolute soft-takeover instead, see emitFader.)
  private encoderStep(key: number, val: number): number {
    const last = this.lastAbs.get(key);
    this.lastAbs.set(key, val);
    if (last == null) return 0; // first sample only seeds the reference (no jump)
    let raw = val - last;
    if (raw > 64) raw -= 128;
    else if (raw < -64) raw += 128;
    return raw;
  }

  // Endless encoder → relative parameter nudge. Treating it as an absolute fader would
  // snap the on-screen value to a meaningless home; the delta keeps it moving from where
  // it is (and never sticks at a rail — see encoderStep).
  private emitKnob(c: ControlSpec, deck: DeckId | undefined, key: number, val: number): void {
    if (c.kind !== "fader") return;
    const raw = this.encoderStep(key, val);
    if (raw === 0) return;
    const delta = (raw / 127) * (c.invert ? -1 : 1);
    this.opts.onEvent({ type: "knob", target: c.target, deck, delta });
  }

  // A relative encoder that fires a discrete ACTION per detent — step-jog that mirrors
  // the arrow keys (so shift→move-loop / adjust-mode parity comes for free via the same
  // handlers). One unit = one step; a fast spin is capped so it can't flood. Deck
  // omitted → focused.
  private dispatchEncoderAction(c: ControlSpec, deck: DeckId | undefined, key: number, val: number): void {
    if (c.kind !== "encoderAction") return;
    const raw = this.encoderStep(key, val);
    if (raw === 0) return;
    const acc = (this.stepAcc.get(key) ?? 0) + raw;
    let n = Math.trunc(acc); // one action per whole unit; carry the rest
    this.stepAcc.set(key, acc - n);
    if (n === 0) return;
    const action = n > 0 ? c.forward : c.backward;
    n = Math.min(4, Math.abs(n)); // cap a violent spin
    const shift = deck ? this.shiftHeld[deck] : false;
    for (let i = 0; i < n; i++) this.opts.onEvent({ type: "button", action, deck, pressed: true, shift });
  }

  // --- keep-alive handshake ---
  private startKeepAlive(): void {
    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
    const sx = this.profile?.initSysex;
    if (!sx || !this.outputs.length) return;
    this.sendSysex(sx); // wake immediately
    const ms = this.profile?.keepAliveMs;
    if (ms) this.keepAlive = setInterval(() => this.sendSysex(sx), ms);
  }

  private sendSysex(bytes: number[]): void {
    for (const out of this.outputs) {
      try {
        out.send(bytes);
      } catch {
        // sysex permission was denied — keep-alive unavailable (degraded, non-fatal).
      }
    }
  }

  // --- LED feedback ---
  /** Light the controller from app state. Diffs against the last frame so only
   *  changed lamps are sent. No-op without a profile feedback map / outputs. */
  setFeedback(deck: DeckId, fb: DeckFeedback): void {
    const p = this.profile;
    if (!p?.feedback || !this.outputs.length) return;
    const prev = this.lastFb[deck];
    const noteStatus = p.noteStatus?.[deck];
    const f = p.feedback;
    const lamp = (data: number | undefined, on: boolean, was: boolean | undefined) => {
      if (data == null || noteStatus == null || on === was) return;
      this.send([noteStatus, data, on ? 0x7f : 0x00]);
    };
    lamp(f.play, fb.play, prev?.play);
    lamp(f.cue, fb.cue, prev?.cue);
    lamp(f.sync, fb.sync, prev?.sync);
    lamp(f.loop, fb.loop, prev?.loop);
    lamp(f.loopIn, fb.loopIn, prev?.loopIn);
    lamp(f.loopOut, fb.loopOut, prev?.loopOut);
    lamp(f.cuePfl, fb.cuePfl, prev?.cuePfl);
    const padStatus = p.padStatus?.[deck];
    if (f.hotcues && padStatus != null) {
      for (let i = 0; i < f.hotcues.length; i++) {
        const on = !!fb.hotcues[i];
        if (on !== prev?.hotcues?.[i]) this.send([padStatus, f.hotcues[i], on ? 0x7f : 0x00]);
      }
    }
    // Pad-mode bank LEDs: when the active mode changed, light the new button and clear the
    // one we were on. (A no-op on a board whose firmware owns these LEDs — the send is
    // simply ignored — but lights the rest of the world for boards that accept it.)
    if (f.padModes && noteStatus != null && fb.padMode !== prev?.padMode) {
      const lit = f.padModes[fb.padMode];
      const off = prev ? f.padModes[prev.padMode] : undefined;
      if (off != null && off !== lit) this.send([noteStatus, off, 0x00]);
      if (lit != null) this.send([noteStatus, lit, 0x7f]);
    }
    this.lastFb[deck] = { ...fb, hotcues: [...fb.hotcues] };
  }

  private send(bytes: number[]): void {
    this.outMon.push({ bytes: bytes.slice(0, 16), seq: ++this.outSeq });
    if (this.outMon.length > MON_MAX) this.outMon.shift();
    for (const out of this.outputs) {
      try {
        out.send(bytes);
      } catch {
        /* output unavailable */
      }
    }
  }
}
