// The deck's effect rack — an Ableton-style channel strip. A deck's signal runs
// through an ORDERED chain of FxDevices spliced between the source and the trim/fader:
//
//   source → rack.input → [dev0] → [dev1] → … → [devN] → rack.output → trim → fader
//
// Each device is a self-contained processing block with plain `input`/`output` gain
// nodes (so the rack can re-wire it without knowing its internals), a bypass, a
// generic string-addressed param bus (so session-sync / automix / MIDI can drive any
// device uniformly), and an optional `dispose` for devices that hold buffers (reverb).
//
// The EQ (Eq3) is the first device by default; it's pinned but reorderable. New
// effects (delay, reverb, chorus…) implement the same FxDevice contract and slot in.

export type FxKind = "eq" | "delay" | "reverb" | "chorus" | "saturator" | "crush" | "mod" | "gate" | "noise";

// Serializable device state — the unit of persistence (profiles) and session sync. The
// wire form lives in src/htl/room/protocol.ts with `kind: string` (forward-compatible);
// this engine-side form narrows it to FxKind. Structurally interchangeable.
export interface FxSlot {
  kind: FxKind;
  bypassed: boolean;
  params: Record<string, number>;
}

export interface FxDevice {
  readonly kind: FxKind;
  /** Signal enters here. */
  readonly input: GainNode;
  /** …and leaves here. The rack chains output→next.input. */
  readonly output: GainNode;

  setBypass(on: boolean): void;
  readonly bypassed: boolean;

  /** Generic param bus — the single seam session-sync/automix/MIDI address. Unknown
   *  ids are ignored (forward-compatible across versions). */
  setParam(id: string, value: number): void;
  getParam(id: string): number;

  /** Flat/neutral: all params back to defaults, bypass off. */
  reset(): void;

  /** Compact param snapshot for serialization (profiles + session rack state). */
  snapshotParams(): Record<string, number>;

  /** Free any held nodes/buffers when removed from the rack (reverb IR, delay lines). */
  dispose?(): void;
}

export class FxRack {
  /** Channel signal enters here (the deck's source + pre-rack taps connect to this). */
  readonly input: GainNode;
  /** Rack output → the deck's trim node. */
  readonly output: GainNode;
  // A permanent inner node the chain hangs off, so `input` itself is never disconnected
  // (the deck taps `input` for its pre-rack spectrum analyser, which must survive every
  // rebuild). Only `chainIn` and device outputs are re-wired.
  private readonly chainIn: GainNode;
  private readonly devices: FxDevice[] = [];

  constructor(ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.chainIn = ctx.createGain();
    this.input.connect(this.chainIn);
    this.rebuild();
  }

  get list(): readonly FxDevice[] {
    return this.devices;
  }
  deviceAt(slot: number): FxDevice | undefined {
    return this.devices[slot];
  }
  indexOf(kind: FxKind): number {
    return this.devices.findIndex((d) => d.kind === kind);
  }

  /** Re-wire chainIn → dev0 → dev1 → … → output. Splicing gain nodes is click-free,
   *  so add/remove/reorder are seamless. Device outputs only ever feed the next device
   *  or `output` (no external taps), so a blanket `output.disconnect()` is safe. */
  private rebuild() {
    try {
      this.chainIn.disconnect();
    } catch {
      /* nothing connected yet */
    }
    for (const d of this.devices) {
      try {
        d.output.disconnect();
      } catch {
        /* ignore */
      }
    }
    let prev: AudioNode = this.chainIn;
    for (const d of this.devices) {
      prev.connect(d.input);
      prev = d.output;
    }
    prev.connect(this.output);
  }

  add(device: FxDevice, slot = this.devices.length): FxDevice {
    // Never insert the same device INSTANCE twice — the EQ is a single shared instance
    // (`deck.eq`) pulled in/out of the chain, so any path that re-adds it while it's already
    // present would duplicate the tab/routing. New effects are fresh instances, so this only
    // ever fires for the EQ. (Closes the "EQ added twice" bug at the routing layer.)
    if (this.devices.includes(device)) return device;
    const at = Math.max(0, Math.min(slot, this.devices.length));
    this.devices.splice(at, 0, device);
    this.rebuild();
    return device;
  }

  remove(slot: number): FxDevice | undefined {
    const d = this.devices[slot];
    if (!d) return undefined;
    this.devices.splice(slot, 1);
    // Sever the removed device's OUTPUT so it can't keep feeding the old next-node. We do
    // NOT touch its input: rebuild() disconnects the prev node's output (severing the link
    // INTO this device), and a reusable device (the EQ) has internal input→… routing that a
    // blanket input.disconnect() would destroy. dispose() handles full teardown for devices
    // that are truly going away (effects); the EQ has no dispose(), so it survives removal.
    try {
      d.output.disconnect();
    } catch {
      /* ignore */
    }
    this.rebuild();
    d.dispose?.();
    return d;
  }

  /** Reorder the chain so the kinds in `order` come first, in that order; any device whose kind
   *  isn't listed keeps its current relative position after them. Stable, one rebuild. Used to
   *  reconcile a fixed-membership rack to a snapshot/peer's chain order without add/remove. */
  orderByKinds(order: ReadonlyArray<string>) {
    const rank = (k: string) => {
      const i = order.indexOf(k);
      return i < 0 ? order.length : i;
    };
    const orig = new Map(this.devices.map((d, i) => [d, i] as const));
    this.devices.sort((a, b) => {
      const ra = rank(a.kind);
      const rb = rank(b.kind);
      return ra !== rb ? ra - rb : (orig.get(a) ?? 0) - (orig.get(b) ?? 0); // stable tiebreak
    });
    this.rebuild();
  }

  /** Move a device from `from` to `to` (indices into the current list). */
  move(from: number, to: number) {
    const n = this.devices.length;
    if (from === to || from < 0 || from >= n || to < 0 || to >= n) return;
    const [d] = this.devices.splice(from, 1);
    // Land the device at FINAL index `to`. Symmetric for a drag (drop target) AND a ±1 step:
    // after the splice the array is one shorter, so clamping `to` to the new length and
    // inserting there puts it exactly at `to`. (An earlier insert-before compensation made a
    // +1 step a no-op — to-1 == from — so reordering only worked one direction.)
    const at = Math.max(0, Math.min(to, this.devices.length));
    this.devices.splice(at, 0, d);
    this.rebuild();
  }
}

// One registered parameter on a device: a stable string id, a getter/setter over the
// underlying AudioParam(s), and a default for reset(). Subclasses populate `params`.
export interface FxParam {
  id: string;
  def: number;
  get(): number;
  set(v: number): void;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// Base for wet/dry effects (delay, reverb, chorus): a dry pass-through in parallel
// with the subclass's wet processing graph, summed at `output`. The subclass builds
// `input → … → wet` in its constructor and registers its params. EQ does NOT extend
// this — it's a fully-wet in-series device (its own class).
//
//   input ─┬─→ dry ───────────────→ output
//          └─→ [subclass wet graph] → wet → output
//
// `mix` (0..1) sets the wet amount; the dry stays at unity so delay/reverb add their
// tails on top of the clean signal (DJ send-style). BYPASS just zeroes the wet send
// (keeps the value, so flipping back restores the same setting) — click-free ramps.
export abstract class BaseFxDevice implements FxDevice {
  abstract readonly kind: FxKind;
  readonly input: GainNode;
  readonly output: GainNode;
  protected readonly ctx: AudioContext;
  protected readonly dry: GainNode;
  protected readonly wet: GainNode; // subclass connects its processed signal into this
  protected readonly params: FxParam[] = [];
  private _bypassed = false;
  private _mix: number;
  // Activation gate (see applyWet): `wet → output` is the ONLY edge from the subclass's
  // processing graph to the destination. When the effect is off we cut it so the audio
  // thread prunes the whole wet subgraph; a generation counter cancels a pending cut if
  // the effect is reactivated first.
  private _wetConnected = true;
  private _wetGen = 0;

  constructor(ctx: AudioContext, defaultMix = 0.3) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this._mix = clamp01(defaultMix);
    this.input.connect(this.dry).connect(this.output);
    this.wet.connect(this.output);
    this.wet.gain.value = this._mix;
    // "mix" is a universal param every wet/dry device exposes.
    this.params.push({ id: "mix", def: this._mix, get: () => this._mix, set: (v) => this.setMix(v) });
  }

  protected setMix(v: number) {
    this._mix = clamp01(v);
    this.applyWet();
  }
  // The effect is "active" only when it's not bypassed AND its wet send is non-zero.
  // Inactive → ramp the send to 0 and, once it has faded, disconnect `wet` from `output`.
  // That leaves the subclass's wet graph (delay lines, filters, feedback, LFOs, sidechains)
  // with NO path to the destination, so the engine prunes it entirely — an off effect costs
  // nothing, not just silence. This is the pattern every wet/dry device inherits, so heavy
  // effects (reverb's FDN, etc.) are free when bypassed or dialled out.
  private applyWet() {
    const active = !this._bypassed && this._mix > 0;
    this.wet.gain.setTargetAtTime(active ? this._mix : 0, this.ctx.currentTime, 0.01);
    if (active) this.connectWet();
    else this.disconnectWetWhenIdle();
  }
  private connectWet() {
    this._wetGen++; // cancel any pending disconnect
    if (this._wetConnected) return;
    this.wet.connect(this.output);
    this._wetConnected = true;
  }
  private disconnectWetWhenIdle() {
    if (!this._wetConnected) return;
    const gen = ++this._wetGen;
    // Let the send fade (~5τ ≈ 50 ms) before pruning so the tail rings out instead of being
    // cut; the generation guard aborts if the effect was reactivated in the meantime.
    setTimeout(() => {
      if (gen !== this._wetGen || !this._wetConnected) return;
      try {
        this.wet.disconnect(this.output);
      } catch {
        /* already gone */
      }
      this._wetConnected = false;
    }, 90);
  }
  /** Current wet amount (0..1) — for subclasses that briefly automate `wet` themselves
   *  (e.g. a Fade time-mode that dips the wet while it re-times). */
  protected get mixAmount() {
    return this._mix;
  }
  protected get isBypassed() {
    return this._bypassed;
  }

  setBypass(on: boolean) {
    // A MANUAL bypass toggle (FLX ON/OFF, toolbar BYPASS) is the SINGLE SOURCE OF TRUTH for on/off:
    // it CLEARS any live throw/latch and drops the boost, so "off means off" — no orphaned latch, no
    // stale re-engage. It ALSO cancels a ring-out that's still in flight: without that, un-bypassing
    // during a tail ("actually, keep it on") would get silently re-bypassed when the timer landed.
    // The throw's OWN bypass moves set _settingBypassInternally so they don't self-clear here.
    if (!this._settingBypassInternally) {
      this._releaseGen++;
      this._releasePending = false;
      if (this._thrown) {
        this._thrown = false;
        this.applyThrowBoost(false);
      }
    }
    this._bypassed = on;
    this.applyWet();
  }
  get bypassed() {
    return this._bypassed;
  }

  // --- throw / latch lifecycle ------------------------------------------------
  // A pad THROW (momentary FX2) or LATCH (FX) engages the effect: un-bypass + a subclass param
  // boost. Bypass is the SINGLE SOURCE OF TRUTH — engaging remembers the prior bypass; releasing
  // RE-READS the live bypass (never a stale capture) before restoring it; and a manual bypass
  // toggle mid-throw clears the whole thing (see setBypass). Latch vs momentary is purely WHEN the
  // caller releases (sticky vs on key-up) — one primitive, two lifetimes.
  private _thrown = false;
  private _throwPrevBypass = false;
  private _settingBypassInternally = false;
  private _releaseGen = 0;
  private _releasePending = false; // a ring-out is in flight: the device is still sounding, on its way back to dormant

  /** Subclass hook: apply (on) / remove (off) the throw's param boost. `off` MUST restore the user's
   *  settings and clear the device's own throw flag so `throwing` reads false. Idempotent. */
  protected applyThrowBoost(_on: boolean): void {}

  /** How long a released throw keeps a DORMANT device active before returning it to bypass, in ms.
   *  This is the difference between the two families of effect: a time-based one (delay repeats,
   *  a reverb bloom) has captured audio that must ring OUT — cutting its send on key-up truncates
   *  the very tail the throw existed to create. An instant one (saturation, crush, gate, noise)
   *  has nothing to ring and should cut cleanly. 0 = cut. Overridden by DelayFx / ReverbFx. */
  protected get throwReleaseMs(): number {
    return 0;
  }

  /** Engage/release a throw. The CALLER's lifetime decides latch (sticky) vs momentary (held). When
   *  already thrown, re-engaging just re-applies the boost (a slam); releasing when not thrown just
   *  ensures the boost is off. Idempotent either way. */
  setThrow(on: boolean) {
    if (on) {
      if (!this._thrown) {
        this._thrown = true;
        // Re-throwing DURING a ring-out must keep the ORIGINAL dormancy: the device is un-bypassed
        // right now only because its tail is still decaying, so re-capturing here would read "was
        // active" and the effect would never go back to sleep.
        if (!this._releasePending) this._throwPrevBypass = this._bypassed;
        this._releaseGen++; // cancel the pending re-bypass — we're sounding again
        this._releasePending = false;
        if (this._bypassed) this.internalSetBypass(false);
      }
      this.applyThrowBoost(true);
    } else {
      if (this._thrown) {
        this._thrown = false;
        this.applyThrowBoost(false); // params back to the user's settings FIRST → the tail decays naturally
        this.scheduleRelease();
        return;
      }
      this.applyThrowBoost(false);
    }
  }
  // Return a dormant device to bypass — after its ring-out, if it has one. Generation-guarded, so a
  // re-throw or a manual bypass in the meantime supersedes it. Re-reads the LIVE bypass rather than
  // trusting the capture, so a hand on the bypass always wins.
  private scheduleRelease() {
    const gen = ++this._releaseGen;
    const land = () => {
      if (gen !== this._releaseGen) return; // superseded
      this._releasePending = false;
      if (this._throwPrevBypass && !this._bypassed) this.internalSetBypass(true);
    };
    const ms = this.throwReleaseMs;
    if (ms <= 0) {
      land();
      return;
    }
    this._releasePending = true;
    setTimeout(land, ms);
  }
  private internalSetBypass(on: boolean) {
    this._settingBypassInternally = true;
    this.setBypass(on);
    this._settingBypassInternally = false;
  }

  setParam(id: string, value: number) {
    this.params.find((p) => p.id === id)?.set(value);
  }
  getParam(id: string): number {
    return this.params.find((p) => p.id === id)?.get() ?? 0;
  }
  snapshotParams(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of this.params) out[p.id] = p.get();
    return out;
  }
  reset() {
    for (const p of this.params) p.set(p.def);
    this.setBypass(false);
  }
  dispose() {
    this._wetGen++; // cancel any pending wet-disconnect timer
    this._releaseGen++; // …and any pending ring-out re-bypass (the device is going away)
    try {
      this.input.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.output.disconnect();
    } catch {
      /* ignore */
    }
  }
}
