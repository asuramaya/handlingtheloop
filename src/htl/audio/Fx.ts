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

export type FxKind = "eq" | "delay" | "reverb" | "chorus" | "saturator" | "crush" | "mod" | "gate" | "noise" | "comp";

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

  /** `hard` skips a device's ring-out (see BaseFxDevice) and cuts immediately; EQ ignores it. */
  setBypass(on: boolean, hard?: boolean): void;
  readonly bypassed: boolean;
  /** True while a bypassed-off tail is still ringing out. EQ has none — always false. */
  readonly releasing: boolean;
  /** Live wet-signal level (0..1). EQ has no separate wet path to fade — always 0. */
  readonly wetLevel: number;
  /** True while a pad THROW (hold or latch) is engaged on this device. EQ has its own, unrelated
   *  curve-throw (see Deck.eqThrowing) — it doesn't implement this. */
  readonly throwing: boolean;

  /** Generic param bus — the single seam session-sync/automix/MIDI address. Unknown
   *  ids are ignored (forward-compatible across versions). */
  setParam(id: string, value: number): void;
  getParam(id: string): number;

  /** Flat/neutral: all params back to defaults, bypass off. */
  reset(): void;

  /** Reset the device's CHARACTER only — every param except `mix`, and never bypass. The
   *  wet/dry and the on/off are performance state a DJ is holding mid-mix; they are not
   *  settings, and a "reset the sound" gesture has no business throwing them away. */
  resetParams(): void;

  /** Compact param snapshot for serialization (profiles + session rack state). */
  snapshotParams(): Record<string, number>;

  /** What `reset()` would put this param back to — so a control can offer its own
   *  neutral on a double-click (the delay's wet/dry rests at 28%, the saturator's at 100%). */
  paramDefault(id: string): number;

  /** Free any held nodes/buffers when removed from the rack (reverb IR, delay lines). */
  dispose?(): void;
}

/** One CHAIN: a set of stems, and the devices that process them.
 *
 *  ★ THE TOPOLOGY. Stem chains are PARALLEL and they PARTITION the stems — a stem belongs to
 *  exactly one chain, so nothing is heard twice and no gain staging is needed anywhere. They all
 *  sum into the MASTER chain, which is not a peer and does not select stems: it is the channel
 *  everything arrives at, downstream of every chain, and it processes the sum.
 *
 *      DRUM ─┐                                 (a stem no chain claimed
 *      BASS ─┼─→ [chain A: GATE → CRUSH] ─┐     runs straight into the sum,
 *     VOICE ─┤                            ├─→ ( + ) → [MASTER: EQ → COMP] → out
 *      INST ─┴─→ [chain B: REVERB] ───────┘
 *
 *  `stems` is a 4-bit mask (1=DRUM 2=BASS 4=VOICE 8=INST) and is meaningless on the master.
 *  `kinds` names devices by kind, because the rack is fixed-membership: one instance of each
 *  exists, so a chain does not own devices, it claims them. */
export interface FxChain {
  id: string;
  name: string;
  stems: number;
  kinds: FxKind[];
  /** The master channel. Exactly one chain carries this, and it is always last. */
  master?: boolean;
}
export const ALL_STEMS = 0b1111;

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
  // Parallel chains. EMPTY is the default and means the plain serial rack above — not a
  // one-chain special case but literally the original code path, so a deck that never touches
  // stem FX cannot pay for the feature in nodes, in taps, or in behaviour.
  private chains: FxChain[] = [];
  private chainNodes: GainNode[] = [];
  private stemTap: ((index: number) => AudioNode | null) | null = null;

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

  /** How to reach a stem tap (Deck supplies it; null while no stretch node is attached). Setting
   *  it does not turn anything on — only a chain that asks for a stem subset ever calls it. */
  setStemSource(fn: ((index: number) => AudioNode | null) | null) {
    this.stemTap = fn;
    if (this.chains.length) this.rebuild();
  }

  /** Declare the parallel chains. An empty list (or a single chain over ALL_STEMS holding every
   *  device in order) is the serial rack, restored exactly. */
  setChains(chains: FxChain[]) {
    this.chains = chains.map((c) => ({ ...c, kinds: [...c.kinds] }));
    this.rebuild();
  }
  get chainList(): readonly FxChain[] {
    return this.chains;
  }
  /** Does any chain listen to a stem SUBSET? The only question the deck needs answered, because
   *  it is exactly the condition for turning the (not free) per-stem taps on. */
  get needsStems(): boolean {
    return this.chains.some((c) => !c.master);
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
    for (const g of this.chainNodes) {
      try {
        g.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.chainNodes = [];
    // Run one chain's devices in order, from `from`, and return the node its signal leaves on.
    const runDevices = (kinds: readonly FxKind[], from: AudioNode): AudioNode => {
      let prev = from;
      for (const k of kinds) {
        const d = this.devices.find((x) => x.kind === k);
        if (!d) continue;
        prev.connect(d.input);
        prev = d.output;
      }
      return prev;
    };
    if (!this.chains.length) {
      runDevices(this.devices.map((d) => d.kind), this.chainIn).connect(this.output);
      return;
    }
    const master = this.chains.find((c) => c.master) ?? this.chains[this.chains.length - 1];
    const stemChains = this.chains.filter((c) => c !== master);
    if (!stemChains.length) {
      // Only the master: the plain serial rack again, just addressed by name.
      runDevices(master.kinds, this.chainIn).connect(this.output);
      return;
    }
    // The sum every parallel branch arrives at, and the master's input. The master does not
    // select stems — it is the channel everything lands on, after the chains.
    const sum = this.output.context.createGain();
    this.chainNodes.push(sum);
    let anyTap = false;
    const claimed = stemChains.reduce((m, c) => m | c.stems, 0);
    for (const c of stemChains) {
      const head = this.output.context.createGain();
      this.chainNodes.push(head);
      for (let i = 0; i < 4; i++) {
        if (!(c.stems & (1 << i))) continue;
        const tap = this.stemTap?.(i);
        if (!tap) continue;
        try {
          tap.connect(head);
          anyTap = true;
        } catch {
          /* a tap that cannot connect leaves this chain silent — see the fallback below */
        }
      }
      runDevices(c.kinds, head).connect(sum);
    }
    // A stem NO chain claimed still has to be heard: it runs dry into the sum, so building a
    // drums-only chain never silently drops the rest of the track.
    for (let i = 0; i < 4; i++) {
      if (claimed & (1 << i)) continue;
      const tap = this.stemTap?.(i);
      if (!tap) continue;
      try {
        tap.connect(sum);
        anyTap = true;
      } catch {
        /* ignore */
      }
    }
    // FALLBACK, and it is not optional: if no tap could be reached at all (no stretch node yet,
    // a hot-swap mid-rebuild), every branch above is silent and the deck would go quiet with a
    // full rack showing. Feed the sum the whole signal instead — wrong routing beats no audio,
    // and the next rebuild with live taps replaces it.
    if (!anyTap) this.chainIn.connect(sum);
    runDevices(master.kinds, sum).connect(this.output);
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

// ★ A THROW GUARANTEES A FLOOR, NOT A FIXED VALUE — and the floor is never an invented number, it's
// the thing's OWN considered resting point. Any object with a gettable/settable mix can use this:
// engage() bumps the value up to `floor` ONLY if it's currently below it (never lowers a mix the
// user deliberately set HIGHER — an earlier version of this forced an exact value unconditionally,
// which would have yanked a hand-raised mix back DOWN for the duration of the hold), remembering
// what was there; release() restores exactly that, or does nothing if engage() never touched it.
// Shared by BaseFxDevice's own throw lifecycle AND the EQ's separate curve-throw (Deck.eqThrow),
// which can't inherit BaseFxDevice (fully-wet in-series, not a send) but wants the identical rule.
export class MixFloorGuard {
  private prev: number | null = null;
  engage(get: () => number, set: (v: number) => void, floor: number | null) {
    if (floor == null) return;
    const cur = get();
    if (cur < floor) {
      this.prev = cur;
      set(floor);
    }
  }
  release(set: (v: number) => void) {
    if (this.prev != null) {
      set(this.prev);
      this.prev = null;
    }
  }
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
// Manual bypass's ring-out ceiling: a SAFETY CAP, not the timer that decides when a tail is done
// (see scheduleBypassRingOut) — high feedback or a long reverb decay can legitimately still be
// audible well past a couple seconds (ReverbFx's own decay knob maps up to a 9s RT60; DelayFx's
// feedback cap of 0.95 can ring for many repeats at a short delay time), and Freeze/near-1.0
// feedback never truly goes silent at all. 12s comfortably covers the former; SOMETHING still has
// to force the cut for the latter, or "off" would never actually mean off.
const RING_CEILING_MS = 12000;
const RING_QUIET_LEVEL = 0.01; // wetLevel below this reads as "not audibly ringing anymore"

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
  // A passive tap on the wet bus itself — not a param, the actual signal — so a UI can fade
  // with what's really still sounding during a ring-out instead of a canned decay curve. Same
  // "tap a SIGNAL, never a param" rule the duck sidechain readback needed (see htl-webaudio-footguns).
  private readonly wetMeter: AnalyserNode;
  private readonly wetMeterBuf: Float32Array<ArrayBuffer>;
  // wetLevel's meter ballistics — see the getter. Persisted across calls, not local to it.
  private _wetEnvelope = 0;
  private _wetEnvelopeT = 0;

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
    this.wetMeter = ctx.createAnalyser();
    // 2048 (~43ms @ 48kHz) so a once-per-frame read (~16ms) never samples a gap between windows —
    // a delay's repeats and a reverb's early reflections are each a loud transient followed by a
    // near-silent stretch, so a SHORT window (256, ~5ms) point-samples that unevenness directly.
    this.wetMeter.fftSize = 2048;
    this.wetMeter.smoothingTimeConstant = 0; // irrelevant to time-domain reads; explicit anyway
    this.wetMeterBuf = new Float32Array(this.wetMeter.fftSize);
    this.wet.connect(this.wetMeter);
    // "mix" is a universal param every wet/dry device exposes.
    this.params.push({ id: "mix", def: this._mix, get: () => this._mix, set: (v) => this.setMix(v) });
  }
  /** Live wet-signal level (0..1), post the mix/bypass gain — for a UI fading a ring-out with the
   *  real tail rather than a timer. NOT the raw instantaneous peak: a delay/reverb tail is a series
   *  of discrete hits, so the raw signal genuinely spikes and drops between them — a UI painting
   *  that directly flickers. This runs it through METER BALLISTICS instead (soft attack, slow
   *  release — the same shape any VU/peak meter uses to read as a graceful fade, not noise), so
   *  it still tracks every real peak, it just doesn't snap back to the floor between them. */
  get wetLevel(): number {
    this.wetMeter.getFloatTimeDomainData(this.wetMeterBuf);
    let peak = 0;
    for (const v of this.wetMeterBuf) {
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    if (peak > 1) peak = 1;
    const now = this.ctx.currentTime;
    const dt = this._wetEnvelopeT ? Math.min(0.25, Math.max(0, now - this._wetEnvelopeT)) : 0;
    this._wetEnvelopeT = now;
    const tau = peak > this._wetEnvelope ? 0.04 : 0.35; // attack / release time constants
    const k = dt > 0 ? Math.exp(-dt / tau) : 0;
    this._wetEnvelope = peak * (1 - k) + this._wetEnvelope * k;
    return this._wetEnvelope;
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
    else this.disconnectWetWhenIdle(90); // ~5τ of the ramp above — a deliberate/instant bypass
  }
  private connectWet() {
    this._wetGen++; // cancel any pending disconnect
    if (this._wetConnected) return;
    this.wet.connect(this.output);
    this._wetConnected = true;
  }
  // pruneAfterMs: how long after the gain ramp starts before physically disconnecting. applyWet()
  // always uses the fast ~90ms default; scheduleBypassRingOut's own closing fade (see below) is
  // slower and passes a matching, longer delay so the disconnect lands after the fade actually
  // finishes rather than chopping it.
  private disconnectWetWhenIdle(pruneAfterMs: number) {
    if (!this._wetConnected) return;
    const gen = ++this._wetGen;
    // The generation guard aborts if the effect was reactivated in the meantime.
    setTimeout(() => {
      if (gen !== this._wetGen || !this._wetConnected) return;
      try {
        this.wet.disconnect(this.output);
      } catch {
        /* already gone */
      }
      this._wetConnected = false;
    }, pruneAfterMs);
  }
  /** Current wet amount (0..1) — for subclasses that briefly automate `wet` themselves
   *  (e.g. a Fade time-mode that dips the wet while it re-times). */
  protected get mixAmount() {
    return this._mix;
  }
  protected get isBypassed() {
    return this._bypassed;
  }
  /** Subclass hook: mute (true) / restore (false) NEW input reaching the wet chain, WITHOUT
   *  touching wet→output. A manual bypass's ring-out keeps wet connected so the tail already
   *  inside the DSP can decay — but if `input` also keeps feeding the wet chain's own entry
   *  point, whatever's still playing keeps RE-EXCITING it (a delay keeps building fresh echoes,
   *  a reverb keeps getting pumped), and the "ring-out" never actually decays — it just sounds
   *  like the effect is still on. No-op by default; only devices with a real tail
   *  (hasTail true) need to override it, at whatever node is their OWN wet-chain entry. */
  protected muteWetInput(_muted: boolean): void {}

  setBypass(on: boolean, hard = false) {
    // A MANUAL bypass toggle (FLX ON/OFF, toolbar BYPASS) is the SINGLE SOURCE OF TRUTH for on/off:
    // it CLEARS any live throw/latch and drops the boost, so "off means off" — no orphaned latch, no
    // stale re-engage. It ALSO cancels a ring-out that's still in flight: without that, un-bypassing
    // during a tail ("actually, keep it on") would get silently re-bypassed when the timer landed.
    // The throw's OWN bypass moves set _settingBypassInternally so they don't self-clear here.
    if (!this._settingBypassInternally) {
      // A REDUNDANT "turn off" while already reporting off (mid ring-out, or long since fully
      // pruned) must be a no-op. Without this, a duplicate call — the same intent arriving
      // twice, another listener applying state that's already applied — falls through to the
      // code below, reads as a FRESH bypass request, and hard-cuts a ring-out already in flight:
      // the tail dies almost immediately instead of riding out for real.
      if (on && this._bypassed && !hard) return;
      if (this._thrown) {
        this._thrown = false;
        this.applyThrowBoost(false);
      }
      // Turning a device WITH A TAIL off: let it ring out the SAME way a pad throw's own release
      // does (see scheduleRelease/beginRingOut — one primitive, two callers) instead of pruning
      // mid-decay. Shift (hard) skips straight to the cut; a device with nothing to ring
      // (hasTail false: sat/crush/gate/noise/comp/mod) always cuts now.
      if (on && !hard && !this._bypassed && this.hasTail) {
        this.beginRingOut();
        return;
      }
      this._releaseGen++;
      this._releasePending = false;
    }
    // Re-engaging (a manual un-bypass, or a throw) always restores live input — hard-kill doesn't
    // need the mirror call: once wet→output is cut below, the whole upstream chain (mute or not)
    // has no path to the destination and the engine prunes it regardless.
    if (!on) this.muteWetInput(false);
    this._bypassed = on;
    this.applyWet();
  }
  get bypassed() {
    return this._bypassed;
  }
  /** True while a bypassed-off device's tail is still ringing out (see beginRingOut). A UI
   *  can use this + `wetLevel` to fade with the real signal instead of snapping on `bypassed`'s
   *  instant flip. Always false once the ring-out lands or on a hard kill. */
  get releasing(): boolean {
    return this._releasePending;
  }
  /** True while a THROW (pad hold or latch) is engaged — the single flag every subclass's own
   *  `throwing` getter used to reimplement by hand with a private twin of this exact bit. Backed
   *  by the same `_thrown` the throw lifecycle below already owns; a subclass with real internal
   *  throw-state (SaturatorFx's drive multiplier, ModFx's depth boost) still keeps that — it's the
   *  MAGNITUDE, not a duplicate of whether a throw is live. */
  get throwing(): boolean {
    return this._thrown;
  }
  // ★ THE SHARED RING-OUT — one mechanic, two callers (a manual bypass-off, and a throw's own
  // release when it lands back on bypass). Both want the exact same thing: report the user-facing
  // state SETTLED right now (bypassed reads true immediately — that's the ask, not a promise about
  // the audio), stop feeding the wet chain fresh input (muteWetInput — only what's ALREADY ringing
  // should decay), then poll the REAL signal and only prune once it's genuinely quiet (or the
  // safety ceiling forces it). A throw's release used to run a completely separate, bespoke path —
  // a bare `setTimeout` for a FIXED duration that never called muteWetInput at all, so a still-
  // playing track kept re-exciting the effect the entire window and the button lied about being
  // off the whole time too. Same disease this session's bypass-button fixes already cured once;
  // it just wasn't yet a SHARED primitive, so releasing a pad throw never inherited the cure.
  private beginRingOut() {
    const gen = ++this._releaseGen;
    this._releasePending = true;
    this._bypassed = true;
    this.muteWetInput(true);
    const startedAt = this.ctx.currentTime;
    const poll = () => {
      if (gen !== this._releaseGen) return; // superseded — re-engaged, hard-killed, or re-scheduled
      const elapsedMs = (this.ctx.currentTime - startedAt) * 1000;
      if (this.wetLevel < RING_QUIET_LEVEL || elapsedMs >= RING_CEILING_MS) {
        this._releasePending = false;
        this.closeRingOut();
        return;
      }
      setTimeout(poll, 80);
    };
    setTimeout(poll, 80);
  }
  // The ring-out's own close — NOT applyWet()'s ~90ms snap (right for a deliberate/instant bypass,
  // wrong here: by the time we land, the tail has genuinely been ringing for seconds, so even the
  // worst case — the ceiling forcing the cut on a still-audible tail — should fade, not chop).
  private closeRingOut() {
    this.wet.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15); // ~750ms to fully settle
    this.disconnectWetWhenIdle(900);
  }

  // --- throw / latch lifecycle ------------------------------------------------
  // A pad THROW (momentary FX2) or LATCH (FX) engages the effect: un-bypass + a subclass param
  // boost + (see throwMix) a guaranteed-audible send. Bypass is the SINGLE SOURCE OF TRUTH —
  // engaging remembers the prior bypass; releasing RE-READS the live bypass (never a stale capture)
  // before restoring it; and a manual bypass toggle mid-throw clears the whole thing (see
  // setBypass). Latch vs momentary is purely WHEN the caller releases (sticky vs on key-up) — one
  // primitive, two lifetimes.
  private _thrown = false;
  private _throwPrevBypass = false;
  private readonly _mixGuard = new MixFloorGuard();
  private _settingBypassInternally = false;
  private _releaseGen = 0;
  private _releasePending = false; // a ring-out is in flight: the device is still sounding, on its way back to dormant

  /** Subclass hook: apply (on) / remove (off) the throw's OWN character boost (feedback, drive,
   *  depth…) — never mix; the base handles mix uniformly (see throwMix) so every device gets a
   *  guaranteed-audible throw for free instead of each one having to remember to touch it. `off`
   *  MUST restore the user's settings. Idempotent. */
  protected applyThrowBoost(_on: boolean): void {}

  /** Does this device have a real tail to ring out (delay repeats, a reverb bloom)? If so, both a
   *  manual bypass-off AND a released throw ride it out via beginRingOut instead of cutting
   *  mid-decay. An instant device (saturation, crush, gate, noise, comp, mod) has nothing to ring
   *  and always lands immediately. False by default; DelayFx/ReverbFx are the only two devices with
   *  captured audio that outlives the gesture, so they're the only two that override it true. */
  protected get hasTail(): boolean {
    return false;
  }
  /** The FLOOR a throw guarantees mix is at LEAST while held (see MixFloorGuard — never lowers a
   *  mix the user set higher, restores exactly what was there the instant it releases). A DJ who
   *  dialled mix down earlier (previewing dry, or just left it low) shouldn't get a silent or
   *  muffled throw with no clue why the pad lit up but nothing changed. Defaults to
   *  `paramDefault("mix")` — the device's OWN considered resting value, never an invented number:
   *  a device whose default is already full-wet (SaturatorFx, CrushFx, GateFx, CompFx) gets full-wet
   *  for free; a device whose default IS a considered blend rather than a compromise (ModFx's 0.5 —
   *  the comb-filter's deepest-notch point) gets exactly THAT floor and nothing more, so a throw can
   *  never collapse its own identity — no special-casing required, it falls out of the same rule.
   *  DelayFx/ReverbFx are the only two that override this UPWARD, on purpose: their whole pad is a
   *  deliberate slam BEYOND the normal dial (0.85, well past their quiet ~0.3 resting default), not
   *  a restoration of it. null opts a device out of the floor entirely (none currently do). */
  protected get throwMix(): number | null {
    return this.paramDefault("mix");
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
        this._mixGuard.engage(() => this.mixAmount, (v) => this.setMix(v), this.throwMix);
      }
      this.applyThrowBoost(true);
    } else {
      if (this._thrown) {
        this._thrown = false;
        this.applyThrowBoost(false); // params back to the user's settings FIRST → the tail decays naturally
        this._mixGuard.release((v) => this.setMix(v));
        this.scheduleRelease();
        return;
      }
      this.applyThrowBoost(false);
    }
  }
  // Return a dormant device to bypass — after its ring-out, if it has one. Re-reads the LIVE bypass
  // rather than trusting the capture, so a hand on the bypass always wins (setBypass already
  // invalidated any pending release the moment it ran, via the same _releaseGen beginRingOut bumps).
  private scheduleRelease() {
    if (!this._throwPrevBypass || this._bypassed) {
      // Nothing to land bypassed — either the device was already active before the throw (a
      // persistent send you're also occasionally throwing — it just keeps running, no tail to
      // manage), or a manual bypass already landed it during the throw itself.
      this._releasePending = false;
      return;
    }
    if (this.hasTail) this.beginRingOut();
    else this.internalSetBypass(true);
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
  paramDefault(id: string): number {
    return this.params.find((p) => p.id === id)?.def ?? 0;
  }
  reset() {
    for (const p of this.params) p.set(p.def);
    this.setBypass(false);
  }
  resetParams() {
    for (const p of this.params) if (p.id !== "mix") p.set(p.def);
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
