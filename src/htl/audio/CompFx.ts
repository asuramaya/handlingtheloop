// COMP — the deck's dynamics processor, and (in LIMIT mode) the master brickwall. The DSP lives in
// an AudioWorklet (compWorklet.ts) because a compressor's identity is its detector and its
// ballistics, and Web Audio's DynamicsCompressorNode exposes neither.
//
//   input ─┬─→ dry·(1−mix) ────────────────────────────────────────────────→ output
//          └─→ [comp worklet] ──────────────────────────────→ wet ─(mix)──→ output
//                    ▲
//   sidechain ───────┘   (input 1: the OTHER deck, or the mic — patched by the engine)
//
// It's an INSERT (dry/wet crossfade like the saturator), not a send — which also hands you
// PARALLEL compression for free: mix at 50% with a hard ratio is the New-York drum trick.
//
// MODE is the instrument: GLUE (SSL-G buss), FET (1176), OPTO (LA-2A), LIMIT (brickwall). The
// worklet reads them all from the same knobs; the ballistics are what change.
import { BaseFxDevice, type FxKind } from "./Fx";
import { clamp } from "./fxDsp";

export const COMP_MODES = ["GLUE", "FET", "OPTO", "LIMIT"] as const;
export type CompMode = (typeof COMP_MODES)[number];

// Sidechain source: what the detector listens to. EXT is the one that matters for DJing — the
// other deck (or the mic) ducks THIS deck, so a vocal or an incoming track carves its own space.
export const COMP_SC_SOURCES = ["INT", "EXT"] as const;

export class CompFx extends BaseFxDevice {
  readonly kind: FxKind = "comp";

  /** External sidechain input — the engine patches the other deck / the mic into this. */
  readonly sidechain: GainNode;
  private node: AudioWorkletNode | null = null;
  private readonly dryLeg: GainNode;

  // Worklet params (the worklet is the source of truth for the sound; these are for getParam).
  private readonly wp: Record<string, number> = {
    mode: 0,
    threshold: -18,
    ratio: 4,
    attackMs: 10,
    releaseMs: 250,
    knee: 6,
    makeupDb: 0,
    auto: 1,
    scHz: 0,
    scExt: 0,
    lookMs: 0,
    ceilingDb: -0.3,
  };
  private _gr = 0; // live gain reduction (dB, ≥ 0) — the needle

  constructor(ctx: AudioContext) {
    super(ctx, 1); // an insert: mix 1 = fully compressed (the dry leg crossfades out)
    this.sidechain = ctx.createGain();
    this.dryLeg = this.dry;

    try {
      this.node = new AudioWorkletNode(ctx, "comp", {
        numberOfInputs: 2, // [0] audio, [1] external sidechain
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: "explicit",
      });
      this.input.connect(this.node, 0, 0);
      this.sidechain.connect(this.node, 0, 1);
      this.node.connect(this.wet);
      this.node.port.onmessage = (e) => {
        const gr = (e.data as { gr?: number }).gr;
        if (typeof gr === "number") this._gr = gr;
      };
      for (const k in this.wp) this.node.port.postMessage({ [k]: this.wp[k] });
    } catch (e) {
      // No worklet (a very early add) → pass the audio through rather than dropping the channel.
      console.warn("[htl] comp worklet unavailable, degrading to a pass-through:", e);
      this.input.connect(this.wet);
    }

    this.applyDry();
    this.registerParams();
  }

  private post(k: string, v: number) {
    this.wp[k] = v;
    this.node?.port.postMessage({ [k]: v });
  }

  // Insert crossfade: the compressed signal REPLACES the dry rather than stacking on top of it
  // (BaseFxDevice keeps dry at unity for sends). At mix < 1 this is parallel compression.
  private applyDry() {
    const dry = this.isBypassed ? 1 : 1 - this.mixAmount;
    this.dryLeg.gain.setTargetAtTime(dry, this.ctx.currentTime, 0.01);
  }
  protected setMix(v: number) {
    super.setMix(v);
    this.applyDry();
  }
  setBypass(on: boolean) {
    super.setBypass(on);
    this.applyDry();
  }

  /** Live gain reduction in dB (≥ 0) — drives the meter. Read every frame; costs nothing. */
  get gainReduction(): number {
    return this._gr;
  }
  get modeIndex(): number {
    return this.wp.mode;
  }

  /** MODE presets its own ballistics — picking FET and leaving a 30 ms attack would be a lie. */
  private setMode(v: number) {
    const m = clamp(Math.round(v), 0, COMP_MODES.length - 1);
    this.post("mode", m);
    if (m === 0) {
      // GLUE — the SSL buss comp: gentle ratio, slow-ish attack lets transients through, auto
      // release does the rest. The sidechain HP is ON by default because that's the whole point.
      this.post("ratio", 4);
      this.post("attackMs", 10);
      this.post("releaseMs", 250);
      this.post("knee", 6);
      this.post("scHz", 80);
      this.post("lookMs", 0);
    } else if (m === 1) {
      // FET — an 1176: it grabs. Fast everything, hard knee.
      this.post("ratio", 8);
      this.post("attackMs", 0.05);
      this.post("releaseMs", 120);
      this.post("knee", 2);
      this.post("lookMs", 0);
    } else if (m === 2) {
      // OPTO — the cell decides; attack and release are program-dependent in the worklet.
      this.post("ratio", 3);
      this.post("attackMs", 10);
      this.post("releaseMs", 600);
      this.post("knee", 10);
      this.post("lookMs", 0);
    } else {
      // LIMIT — a ceiling, not a suggestion. Lookahead makes it true.
      this.post("knee", 1);
      this.post("attackMs", 0.2);
      this.post("releaseMs", 80);
      this.post("lookMs", 1.5);
    }
  }

  private registerParams() {
    this.params.push(
      { id: "mode", def: 0, get: () => this.wp.mode, set: (v) => this.setMode(v) },
      { id: "threshold", def: -18, get: () => this.wp.threshold, set: (v) => this.post("threshold", clamp(v, -60, 0)) },
      { id: "ratio", def: 4, get: () => this.wp.ratio, set: (v) => this.post("ratio", clamp(v, 1, 20)) },
      { id: "attack", def: 10, get: () => this.wp.attackMs, set: (v) => this.post("attackMs", clamp(v, 0.02, 100)) },
      { id: "release", def: 250, get: () => this.wp.releaseMs, set: (v) => this.post("releaseMs", clamp(v, 20, 3000)) },
      { id: "knee", def: 6, get: () => this.wp.knee, set: (v) => this.post("knee", clamp(v, 0, 24)) },
      { id: "makeup", def: 0, get: () => this.wp.makeupDb, set: (v) => this.post("makeupDb", clamp(v, -12, 24)) },
      { id: "auto", def: 1, get: () => this.wp.auto, set: (v) => this.post("auto", v >= 0.5 ? 1 : 0) },
      // The sidechain high-pass. Without it the kick pumps the whole track — this one filter is
      // most of why a buss compressor works at all.
      { id: "scHp", def: 0, get: () => this.wp.scHz, set: (v) => this.post("scHz", v <= 20 ? 0 : clamp(v, 20, 500)) },
      { id: "scExt", def: 0, get: () => this.wp.scExt, set: (v) => this.post("scExt", v >= 0.5 ? 1 : 0) },
      { id: "lookahead", def: 0, get: () => this.wp.lookMs, set: (v) => this.post("lookMs", clamp(v, 0, 10)) },
      { id: "ceiling", def: -0.3, get: () => this.wp.ceilingDb, set: (v) => this.post("ceilingDb", clamp(v, -12, 0)) },
    );
  }

  /** The pad throw: slam the threshold down + hit it harder. Released → back to the user's setting.
   *  Mix is guaranteed audible by the base class (see BaseFxDevice.throwMix). */
  private _throwPrev: { thr: number; ratio: number } | null = null;
  protected applyThrowBoost(on: boolean) {
    if (on) {
      if (this._throwPrev == null) this._throwPrev = { thr: this.wp.threshold, ratio: this.wp.ratio };
      this.post("threshold", Math.max(-60, this.wp.threshold - 18));
      this.post("ratio", Math.min(20, Math.max(this.wp.ratio, 10)));
    } else {
      const p = this._throwPrev;
      this._throwPrev = null;
      if (!p) return;
      this.post("threshold", p.thr);
      this.post("ratio", p.ratio);
    }
  }

  dispose() {
    try {
      this.node?.disconnect();
      this.sidechain.disconnect();
    } catch {
      /* ignore */
    }
    super.dispose();
  }
}

/** Master-bus brickwall: the same worklet, in LIMIT mode, guaranteeing nothing leaves above the
 *  ceiling. With the EQ reaching +12 and the saturator driving +20, the stack needs an end-stop —
 *  otherwise every aggressive move is a gamble on the browser's clipping. */
export function makeMasterLimiter(ctx: AudioContext): CompFx {
  const c = new CompFx(ctx);
  c.setParam("mode", 3); // LIMIT
  c.setParam("ceiling", -0.3);
  c.setParam("lookahead", 1.5);
  c.setParam("mix", 1);
  c.setParam("auto", 0); // a limiter must never invent makeup gain
  return c;
}
