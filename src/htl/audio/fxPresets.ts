// Per-effect user presets, stored client-side (localStorage), keyed by effect kind so a
// preset is shared across both decks. Minimal by design: a built-in "Default" (the device's
// reset state, not stored here) plus user-saved snapshots of the current param set. The
// menu that drives this lives in FxStrip (right-click an effect tab).

export interface FxPreset {
  name: string;
  params: Record<string, number>;
}

// FACTORY presets — built-in, read-only banks shipped in code, shown in the effect's preset menu
// ABOVE the user's own saved snapshots (which stay in localStorage) and below the device Default.
// Each `params` map is a COMPLETE param set: applyPreset only writes the listed ids, so a preset
// must fully define the device state (otherwise it inherits whatever knobs happened to be set).
// Seeded one effect at a time; the operator auditions + tweaks, then the bank is locked.
export const FACTORY_PRESETS: Record<string, FxPreset[]> = {
  // SATURATOR — the 5 style curves (TUBE/TAPE/CLIP/FOLD/DIODE) crossed with the multiband drives
  // (drive0=low <250 Hz, drive1=mid, drive2=high >2.5 kHz) so a style becomes several sounds:
  // saturate just the lows (weight, no fizz) or just the highs (air). `mix` sets how hard it hits
  // (auto gain-comp keeps it dirt-not-loudness); `bias` adds even harmonics; `punish` steepens.
  saturator: [
    { name: "Warm Bus", params: { style: 1, punish: 0, bias: 0.1, tone: 0.46, out: 0.5, drive0: 0.45, drive1: 0.4, drive2: 0.35, xover0: 0.366, xover1: 0.699, mix: 0.35 } },
    { name: "Tube Warmth", params: { style: 0, punish: 0, bias: 0.35, tone: 0.55, out: 0.5, drive0: 0.5, drive1: 0.5, drive2: 0.45, xover0: 0.366, xover1: 0.699, mix: 0.5 } },
    { name: "Tube Slam", params: { style: 0, punish: 1, bias: 0.4, tone: 0.55, out: 0.44, drive0: 0.75, drive1: 0.72, drive2: 0.6, xover0: 0.366, xover1: 0.699, mix: 0.72 } },
    { name: "Low-End Weight", params: { style: 0, punish: 1, bias: 0.2, tone: 0.5, out: 0.5, drive0: 0.85, drive1: 0.28, drive2: 0.12, xover0: 0.366, xover1: 0.699, mix: 0.6 } },
    { name: "Top Air", params: { style: 2, punish: 0, bias: 0, tone: 0.62, out: 0.48, drive0: 0.12, drive1: 0.22, drive2: 0.7, xover0: 0.366, xover1: 0.699, mix: 0.32 } },
    { name: "Transistor Fuzz", params: { style: 2, punish: 1, bias: 0.15, tone: 0.6, out: 0.4, drive0: 0.68, drive1: 0.8, drive2: 0.68, xover0: 0.366, xover1: 0.699, mix: 0.82 } },
    { name: "Metal Fold", params: { style: 3, punish: 1, bias: 0.3, tone: 0.5, out: 0.4, drive0: 0.58, drive1: 0.75, drive2: 0.64, xover0: 0.366, xover1: 0.699, mix: 0.6 } },
    { name: "Diode Honk", params: { style: 4, punish: 1, bias: 0.55, tone: 0.55, out: 0.4, drive0: 0.62, drive1: 0.8, drive2: 0.58, xover0: 0.366, xover1: 0.699, mix: 0.7 } },
  ],
  // DELAY (ECHO) — a dub/DJ delay. Beat-locked (`sync:1`), so `div` (0=1/16…8=1 bar) is the
  // musical identity and `time` is just the 120-BPM echo of it (recomputed live from the deck
  // tempo). `feedback` sets the tail length; the in-loop HP/LP narrow each repeat (dub sweep);
  // `analog`/`lofi` colour the tails; `stereo:1` = ping-pong; `spread` drifts L/R for width.
  delay: [
    { name: "1/8 Slap", params: { mix: 0.26, time: 0.25, feedback: 0.28, hp: 200, lp: 8000, sync: 1, div: 2, timeMode: 0, stereo: 0, link: 0, freeze: 0, analog: 0, lofi: 0, modDepth: 0, modRate: 0.5, duck: 0, spread: 0 } },
    { name: "1/4 Dub", params: { mix: 0.32, time: 0.5, feedback: 0.5, hp: 180, lp: 3800, sync: 1, div: 4, timeMode: 0, stereo: 0, link: 0, freeze: 0, analog: 0.4, lofi: 0, modDepth: 0, modRate: 0.5, duck: 0, spread: 0.15 } },
    { name: "Ping-Pong 1/8", params: { mix: 0.3, time: 0.25, feedback: 0.42, hp: 160, lp: 7000, sync: 1, div: 2, timeMode: 0, stereo: 1, link: 0, freeze: 0, analog: 0, lofi: 0, modDepth: 0, modRate: 0.5, duck: 0, spread: 0.3 } },
    { name: "Triplet Throw", params: { mix: 0.3, time: 0.167, feedback: 0.42, hp: 150, lp: 6000, sync: 1, div: 1, timeMode: 0, stereo: 0, link: 0, freeze: 0, analog: 0.2, lofi: 0, modDepth: 0, modRate: 0.5, duck: 0, spread: 0 } },
    { name: "Tape Echo", params: { mix: 0.3, time: 0.5, feedback: 0.46, hp: 220, lp: 3200, sync: 1, div: 4, timeMode: 0, stereo: 0, link: 0, freeze: 0, analog: 0.6, lofi: 0, modDepth: 0.004, modRate: 0.8, duck: 0, spread: 0.2 } },
    { name: "Lo-Fi Bounce", params: { mix: 0.3, time: 0.375, feedback: 0.44, hp: 200, lp: 5000, sync: 1, div: 3, timeMode: 0, stereo: 1, link: 0, freeze: 0, analog: 0.15, lofi: 1, modDepth: 0, modRate: 0.5, duck: 0, spread: 0.25 } },
    { name: "Half-Bar Wash", params: { mix: 0.3, time: 1.0, feedback: 0.4, hp: 300, lp: 2600, sync: 1, div: 6, timeMode: 0, stereo: 1, link: 0, freeze: 0, analog: 0.3, lofi: 0, modDepth: 0.003, modRate: 0.4, duck: 0, spread: 0.4 } },
    { name: "Freeze Hold", params: { mix: 0.4, time: 0.5, feedback: 0.6, hp: 140, lp: 5500, sync: 1, div: 4, timeMode: 0, stereo: 0, link: 0, freeze: 1, analog: 0, lofi: 0, modDepth: 0, modRate: 0.5, duck: 0, spread: 0 } },
  ],
  // REVERB (VERB) — the Jot FDN tank. `style` (0 HALL/1 ROOM/2 PLATE/3 AMBIENT) picks the voicing;
  // `size`×`decay` set the space and tail; `lowCut`/`highCut` keep the wet out of the mud and the
  // fizz; `duck` blooms the tail in the gaps; `character`/`modRate` add movement; post shelves tilt.
  reverb: [
    { name: "Vocal Plate", params: { mix: 0.28, size: 0.5, decay: 0.5, brightness: 0.7, predelay: 0.02, width: 1.1, lowCut: 200, highCut: 12000, drive: 0, character: 0, modRate: 0.35, postLow: 0, postHigh: 0, duck: 0, freeze: 0, style: 2 } },
    { name: "Drum Room", params: { mix: 0.25, size: 0.35, decay: 0.35, brightness: 0.55, predelay: 0.008, width: 1, lowCut: 120, highCut: 9000, drive: 0, character: 0, modRate: 0.35, postLow: 0, postHigh: 0, duck: 0, freeze: 0, style: 1 } },
    { name: "Big Hall", params: { mix: 0.32, size: 0.85, decay: 0.75, brightness: 0.55, predelay: 0.03, width: 1.2, lowCut: 150, highCut: 10000, drive: 0, character: 0.15, modRate: 0.4, postLow: 0, postHigh: 0, duck: 0, freeze: 0, style: 0 } },
    { name: "Ambient Wash", params: { mix: 0.35, size: 0.9, decay: 0.85, brightness: 0.65, predelay: 0.02, width: 1.3, lowCut: 250, highCut: 12000, drive: 0, character: 0.4, modRate: 0.5, postLow: 0, postHigh: 0, duck: 0, freeze: 0, style: 3 } },
    { name: "Ducked Verb", params: { mix: 0.34, size: 0.7, decay: 0.65, brightness: 0.6, predelay: 0.015, width: 1.1, lowCut: 180, highCut: 9000, drive: 0, character: 0, modRate: 0.35, postLow: 0, postHigh: 0, duck: 0.6, freeze: 0, style: 0 } },
    { name: "Short Room", params: { mix: 0.3, size: 0.4, decay: 0.25, brightness: 0.6, predelay: 0.005, width: 1, lowCut: 150, highCut: 11000, drive: 0, character: 0, modRate: 0.35, postLow: 0, postHigh: 0, duck: 0, freeze: 0, style: 1 } },
    { name: "Dark Chamber", params: { mix: 0.3, size: 0.75, decay: 0.7, brightness: 0.3, predelay: 0.02, width: 1, lowCut: 120, highCut: 6000, drive: 0.25, character: 0.2, modRate: 0.3, postLow: 3, postHigh: -6, duck: 0, freeze: 0, style: 0 } },
    { name: "Shimmer Air", params: { mix: 0.3, size: 0.8, decay: 0.8, brightness: 0.85, predelay: 0.02, width: 1.25, lowCut: 300, highCut: 16000, drive: 0, character: 0.5, modRate: 0.6, postLow: 0, postHigh: 4, duck: 0, freeze: 0, style: 2 } },
  ],
  // MOD — chorus/flanger/phaser off one shared LFO. `mode` picks the engine; `rate` is a 0..1 knob
  // (free Hz, ~0.05‥10, since these run un-synced); `depth`×`feedback` set the intensity/resonance;
  // `thru:1` = through-zero flange; `stages` deepens the phaser; `wave:2` = square (stepped sweep).
  mod: [
    { name: "Lush Chorus", params: { mix: 0.45, mode: 0, rate: 0.5, depth: 0.5, feedback: 0.2, tone: 0.5, stages: 6, wave: 0, src: 0, thru: 0, sync: 0 } },
    { name: "Wide Ensemble", params: { mix: 0.5, mode: 0, rate: 0.43, depth: 0.7, feedback: 0.1, tone: 0.55, stages: 6, wave: 0, src: 0, thru: 0, sync: 0 } },
    { name: "Jet Flanger", params: { mix: 0.5, mode: 1, rate: 0.5, depth: 0.6, feedback: 0.6, tone: 0.5, stages: 6, wave: 0, src: 0, thru: 0, sync: 0 } },
    { name: "Through-Zero", params: { mix: 0.5, mode: 1, rate: 0.55, depth: 0.75, feedback: 0.5, tone: 0.5, stages: 6, wave: 0, src: 0, thru: 1, sync: 0 } },
    { name: "Slow Phaser", params: { mix: 0.5, mode: 2, rate: 0.4, depth: 0.6, feedback: 0.4, tone: 0.5, stages: 6, wave: 0, src: 0, thru: 0, sync: 0 } },
    { name: "Deep Phaser 8", params: { mix: 0.5, mode: 2, rate: 0.45, depth: 0.8, feedback: 0.6, tone: 0.45, stages: 8, wave: 0, src: 0, thru: 0, sync: 0 } },
    { name: "Vibrato", params: { mix: 0.6, mode: 0, rate: 0.6, depth: 0.9, feedback: 0, tone: 0.5, stages: 6, wave: 0, src: 0, thru: 0, sync: 0 } },
    { name: "Square Phaser", params: { mix: 0.5, mode: 2, rate: 0.5, depth: 0.7, feedback: 0.3, tone: 0.5, stages: 4, wave: 2, src: 0, thru: 0, sync: 0 } },
  ],
  // CRUSH — bit + sample-rate reduction into a resonant reconstruction filter. `mode` (0 S&H/1 ZERO/
  // 2 VINTAGE/3 JITTER) is the decimator flavour; `bits` (0 clean→1 smashed) and `rate` (downsample)
  // are the two destroyers; `cut`/`res` shape the DAC filter (1=open). `mix` blends grit under the dry.
  crush: [
    { name: "Gentle Grit", params: { mix: 0.5, mode: 0, bits: 0.3, rate: 0.2, jitter: 0, cut: 0.9, res: 0.2 } },
    { name: "8-Bit", params: { mix: 1, mode: 0, bits: 0.55, rate: 0.35, jitter: 0, cut: 1, res: 0.2 } },
    { name: "Telephone", params: { mix: 1, mode: 2, bits: 0.45, rate: 0.3, jitter: 0, cut: 0.5, res: 0.5 } },
    { name: "SR Smash", params: { mix: 1, mode: 0, bits: 0.2, rate: 0.75, jitter: 0, cut: 1, res: 0.3 } },
    { name: "Vintage Sampler", params: { mix: 1, mode: 2, bits: 0.5, rate: 0.55, jitter: 0, cut: 0.7, res: 0.3 } },
    { name: "Zero Buzz", params: { mix: 1, mode: 1, bits: 0.6, rate: 0.4, jitter: 0, cut: 0.85, res: 0.4 } },
    { name: "Jitter Wobble", params: { mix: 1, mode: 3, bits: 0.45, rate: 0.4, jitter: 0.6, cut: 0.9, res: 0.3 } },
    { name: "Destroy", params: { mix: 1, mode: 0, bits: 0.85, rate: 0.8, jitter: 0, cut: 1, res: 0.5 } },
  ],
  // GATE — a tempo-synced amplitude gate. `rate` is a 0..1 knob quantized to [1/4,1/8,1/8T,1/16,
  // 1/16T,1/32] (0=1/4 … 1=1/32); `shape` (0 SQUARE/1 PLUCK/2 RAMP/3 TRI/4 SINE) is the feel; `depth`
  // = how far it ducks; `duty` = open fraction; `smooth` rounds the edges (declick). All beat-synced.
  gate: [
    { name: "1/8 Stutter", params: { mix: 1, rate: 0.2, depth: 0.9, duty: 0.5, smooth: 0.1, shape: 0, sync: 1 } },
    { name: "1/16 Chop", params: { mix: 1, rate: 0.6, depth: 1, duty: 0.5, smooth: 0.08, shape: 0, sync: 1 } },
    { name: "Trance Pluck", params: { mix: 1, rate: 0.2, depth: 0.9, duty: 0.8, smooth: 0.2, shape: 1, sync: 1 } },
    { name: "Triplet Gate", params: { mix: 1, rate: 0.4, depth: 0.9, duty: 0.5, smooth: 0.12, shape: 0, sync: 1 } },
    { name: "Sine Pump", params: { mix: 0.9, rate: 0, depth: 0.7, duty: 0.9, smooth: 0.4, shape: 4, sync: 1 } },
    { name: "Ramp Swell", params: { mix: 1, rate: 0.2, depth: 0.85, duty: 0.8, smooth: 0.2, shape: 2, sync: 1 } },
    { name: "Tri Wobble", params: { mix: 1, rate: 0, depth: 0.8, duty: 0.95, smooth: 0.3, shape: 3, sync: 1 } },
    { name: "1/32 Machine Gun", params: { mix: 1, rate: 1, depth: 1, duty: 0.5, smooth: 0.05, shape: 0, sync: 1 } },
  ],
  // NOISE — a riser/uplifter GENERATOR (adds a swept noise layer on top; dry passes through). `type`
  // (0 WHITE/1 PINK/2 TONAL); `rise:1` = tempo-synced auto-build over `bars` (the pad-throw sweeps up),
  // `rise:0` = manual gate you ride by hand at `sweep`. `res` = sweep resonance; `tone` = post brightness.
  noise: [
    { name: "4-Bar Riser", params: { mix: 0.5, type: 0, sweep: 0.3, res: 0.4, tone: 0.8, rise: 1, bars: 4 } },
    { name: "8-Bar Build", params: { mix: 0.45, type: 1, sweep: 0.3, res: 0.3, tone: 0.75, rise: 1, bars: 8 } },
    { name: "2-Bar Lift", params: { mix: 0.5, type: 0, sweep: 0.3, res: 0.5, tone: 0.85, rise: 1, bars: 2 } },
    { name: "Tonal Uplifter", params: { mix: 0.5, type: 2, sweep: 0.3, res: 0.6, tone: 0.8, rise: 1, bars: 4 } },
    { name: "Manual Sweep", params: { mix: 0.5, type: 0, sweep: 0.5, res: 0.7, tone: 0.9, rise: 0, bars: 4 } },
    { name: "White Wash", params: { mix: 0.4, type: 0, sweep: 0.1, res: 0.2, tone: 0.7, rise: 0, bars: 4 } },
    { name: "Pink Air", params: { mix: 0.35, type: 1, sweep: 0.6, res: 0.3, tone: 0.6, rise: 0, bars: 4 } },
    { name: "1-Bar Snap", params: { mix: 0.55, type: 0, sweep: 0.3, res: 0.5, tone: 0.85, rise: 1, bars: 1 } },
  ],
  // EQ — the per-deck parametric channel EQ (Eq3). No `mix` in its param bus; gains are dB in the
  // ASYMMETRIC DJ range −26…+6 (big cuts, modest boosts). `*Shape` sets each band's filter (0 BELL/
  // 1 LO-SH/2 HI-SH/3 NOTCH); `hpFreq`/`lpFreq` are the sweepable cut filters (parked at 20/20000 = off).
  // EQ — the channel EQ, and (since it took the 8th FX pad) a PERFORMANCE curve. These are all
  // THROWS: hold the pad, the curve slams in; let go, your ride comes back. So every one of them
  // is a gesture you'd hear from the back of the room — not a mastering nudge. (The first bank was
  // 5 tone-shaping curves averaging ±3 dB; on a pad that's a dead button.)
  //   • band gains reach ±40/+12 now, so a "kill" is a real kill (the low shelf at −40 is GONE).
  //   • `out` is the curve's own output trim: a preset that guts half the spectrum pays itself
  //     back here, so throws land at roughly the level you left. Values below are measured in
  //     fxlab against a full-scale tone, not guessed.
  //   • shapes: 0 = bell, 1 = low-shelf, 2 = high-shelf, 3 = notch.
  eq: [
    // The two swap tools. A bass kill you can hold through a transition, and its mirror.
    { name: "Bass Kill", params: { low: -40, mid: 0, high: 0, lowFreq: 90, midFreq: 1000, highFreq: 3200, midQ: 0.9, hpFreq: 20, hpQ: 0.7, lpFreq: 20000, lpQ: 0.7, lowShape: 1, midShape: 0, highShape: 2, lowQ: 1, highQ: 1, out: 0 } },
    { name: "High Kill", params: { low: 0, mid: 0, high: -40, lowFreq: 200, midFreq: 1000, highFreq: 6000, midQ: 0.9, hpFreq: 20, hpQ: 0.7, lpFreq: 20000, lpQ: 0.7, lowShape: 1, midShape: 0, highShape: 2, lowQ: 1, highQ: 1, out: 0 } },
    // Hollow it out — the drums and the sub stay, the body leaves.
    { name: "Mid Scoop", params: { low: 0, mid: -14, high: 0, lowFreq: 200, midFreq: 800, highFreq: 3200, midQ: 0.7, hpFreq: 20, hpQ: 0.7, lpFreq: 20000, lpQ: 0.7, lowShape: 1, midShape: 0, highShape: 2, lowQ: 1, highQ: 1, out: 1 } },
    // Band-limited voices. TELEPHONE is the wide one (500 Hz – 3 kHz), RADIO is the tight one.
    { name: "Telephone", params: { low: 0, mid: 6, high: 0, lowFreq: 200, midFreq: 1500, highFreq: 3200, midQ: 1, hpFreq: 500, hpQ: 0.9, lpFreq: 3000, lpQ: 0.9, lowShape: 1, midShape: 0, highShape: 2, lowQ: 1, highQ: 1, out: 0 } },
    { name: "Radio", params: { low: 0, mid: 5, high: 0, lowFreq: 200, midFreq: 1400, highFreq: 3200, midQ: 2, hpFreq: 800, hpQ: 1.5, lpFreq: 2200, lpQ: 1.5, lowShape: 1, midShape: 0, highShape: 2, lowQ: 1, highQ: 1, out: 1.5 } },
    // The two filter PARKS — a resonant cutoff dropped on the track and held there.
    { name: "Sub Drop", params: { low: 0, mid: 0, high: 0, lowFreq: 200, midFreq: 1000, highFreq: 3200, midQ: 0.9, hpFreq: 20, hpQ: 0.7, lpFreq: 320, lpQ: 5, lowShape: 1, midShape: 0, highShape: 2, lowQ: 1, highQ: 1, out: 2 } },
    { name: "Riser", params: { low: 0, mid: 0, high: 0, lowFreq: 200, midFreq: 1000, highFreq: 3200, midQ: 0.9, hpFreq: 1000, hpQ: 8, lpFreq: 20000, lpQ: 0.7, lowShape: 1, midShape: 0, highShape: 2, lowQ: 1, highQ: 1, out: 0 } },
    // A deep null through the middle — the track goes hollow without losing its ends.
    { name: "Deep Notch", params: { low: 0, mid: 0, high: 0, lowFreq: 200, midFreq: 1000, highFreq: 3200, midQ: 1.2, hpFreq: 20, hpQ: 0.7, lpFreq: 20000, lpQ: 0.7, lowShape: 1, midShape: 3, highShape: 2, lowQ: 1, highQ: 1, out: 0 } },
  ],
};

/** The built-in factory bank for an effect kind (read-only; [] if none seeded yet). */
export function factoryFxPresets(kind: string): FxPreset[] {
  return FACTORY_PRESETS[kind] ?? [];
}

const KEY = (kind: string) => `htl:fxpreset:${kind}`;

export function loadFxPresets(kind: string): FxPreset[] {
  try {
    const raw = localStorage.getItem(KEY(kind));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((p) => p && typeof p.name === "string" && p.params && typeof p.params === "object") : [];
  } catch {
    return [];
  }
}

export function saveFxPreset(kind: string, name: string, params: Record<string, number>): FxPreset[] {
  const clean = name.trim();
  if (!clean) return loadFxPresets(kind);
  const list = loadFxPresets(kind).filter((p) => p.name !== clean); // overwrite a same-name preset
  list.push({ name: clean, params });
  try {
    localStorage.setItem(KEY(kind), JSON.stringify(list));
  } catch {
    /* quota / unavailable — the preset just won't persist this session */
  }
  return list;
}

export function renameFxPreset(kind: string, oldName: string, newName: string): FxPreset[] {
  const clean = newName.trim();
  const list = loadFxPresets(kind);
  const found = list.find((p) => p.name === oldName);
  if (!clean || !found) return list;
  const next = list.filter((p) => p.name !== oldName && p.name !== clean);
  next.push({ name: clean, params: found.params });
  try {
    localStorage.setItem(KEY(kind), JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

export function deleteFxPreset(kind: string, name: string): FxPreset[] {
  const list = loadFxPresets(kind).filter((p) => p.name !== name);
  try {
    localStorage.setItem(KEY(kind), JSON.stringify(list));
  } catch {
    /* ignore */
  }
  return list;
}
