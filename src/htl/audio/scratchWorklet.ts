// AudioWorklet source for the jog/scratch sound — the single continuous resampler
// that every real turntable emulator (Mixxx, Serato, …) uses:
//
//   • ONE moving read pointer (`pos`, a fractional sample index) walks the whole
//     track. No per-frame grains → no boundary clicks, no zipper noise.
//   • It's driven by POSITION only: the deck sends the platter position ~60×/s and
//     the worklet reconstructs smooth motion by linearly connecting consecutive
//     positions over the MEASURED interval between them. No noisy hand-velocity in
//     the audio loop — that's what turned scratches into garbled fast-forward.
//   • Signed motion → reverse and crossing zero are the same code path; no reversed
//     buffer copy.
//   • 4-point cubic (Catmull-Rom) interpolation reads between samples cleanly
//     (linear dulls/aliases under the fast-changing scratch rate).
//   • A velocity-dependent lowpass anti-aliases the speed-up case (reading faster
//     than 1× is decimation, which would otherwise fold highs back as metallic
//     grunge); below 1× it opens fully and keeps all the highs.
//   • Reads PCM live out of a registry shared with the stretch (playback) worklet —
//     see the module-scope note below — instead of holding its own copy, so a scratch
//     is never more than a live view onto whatever stretch already has resident.
//
// Loaded via a Blob URL so it's bundler-agnostic (see AudioEngine).
export const SCRATCH_WORKLET_SRC = `
// Both this module and stretchWorklet.ts load into the SAME AudioWorkletGlobalScope
// (one global scope per BaseAudioContext — separate addModule() calls on the same
// context share it), so a module-scope registry keyed by deck id lets this processor
// read the stretch worklet's already-resident PCM directly, with zero extra copies and
// no message round-trip. Idempotent regardless of which module's addModule() lands
// first. Replaces the old per-worklet PCM transfer + the mobile windowed-PCM-extraction
// machinery entirely (see stretchWorklet.ts's loadPcm handler, the writer side).
if (!globalThis.__htlPcm) globalThis.__htlPcm = new Map();

// The shortest stretch of wall clock a re-pace may measure speed over. Shorter updates still move
// the TARGET (the chase always aims at the newest position); they just bank their time.
//
// ★ IT WAS ONE RENDER QUANTUM (128 samples, ~2.7 ms), AND THAT IS WHAT MADE A JOG "TRIP OVER
// ITSELF". Operator: "smeared and trips over itself... not nearly as bad on touch, noticeably
// worse on mouse, and super bad on board". A DDJ-FLX4 moves in whole 720/rev ticks (2.5 ms of
// audio each) on a 1 ms USB clock, so a 2.7 ms window holds 0, 1 or 2 ticks and the speed snapped
// between ~0×, 0.93× and 1.85× during a steady 0.35× drag. Touch never saw it: its updates are
// 16.7 ms apart, already longer than the window. Measured by driving THIS source with one hand
// motion through three input shapes (scripts/joglab/scratchreplay.mjs):
//   window      board roughness   board lag   board trips   touch / mouse
//   128 (2.7ms)      0.239           2.7 ms        26        unchanged
//   512 (10.7ms)     0.044          13.3 ms        11        unchanged
//   768 (16ms)       0.052          21.3 ms        19        unchanged
// 512 brought the synthetic board level with touch (0.048) at a lag far under touch's own ~37 ms,
// and costs pointer input nothing (their gaps already exceed it).
// THEN A REAL CAPTURE (operator's FLX4, 2026-11-02, 18.3 s, replayed through this source) moved it
// to 640 together with the granular threshold below: real scratching scored roughness 1.698 at 128,
// 0.569 at 512, and 0.194 at 640 once the granular threshold stopped firing on ordinary fast
// strokes; the synthetic board stays at 0.044 with its fewest false reversals (10). (That
// recorder stores whole milliseconds, which adds jitter longer windows average away, so the real
// capture is biased toward longer windows; 640 rather than its preferred 768 is the hedge.)
const MIN_INTERVAL = 640;
// How far a move from rest may travel and still be a MICRO JOG (seconds of audio), played as the
// hand's own trajectory (see HAND TRAJECTORY below). A nudge is a few ticks (2.5 ms each); a scratch
// sweeps tens of milliseconds and more.
const MICRO_SPAN = 0.06;
// HAND TRAJECTORY timing (seconds), all from the operator's FLX4 capture (fixtures/flx4-jog-real-
// 2026-11-02.json, every start of motion after >= 30 ms of stillness):
//  TJ_WAIT    how long the first tick after rest waits for a second one to learn the hand's pace.
//             The gap from the first to the second tick was 0-6 ms in 17 of 20 starts, then 14, 15
//             and 23 ms, so 6.5 ms catches the common case and costs nothing more than that wait.
//  TJ_SINGLE  the duration given to a tick whose follower did not come inside TJ_WAIT: a slow
//             finger. Over all 47 starts in the capture (after stillness or at a reversal), the 13
//             first gaps longer than TJ_WAIT were 7-23 ms, median 10, so a lone tick plays over
//             10 ms (0.25x).
//  TJ_MIN     the shortest segment: ticks share a 1 ms USB frame, so a gap under 1 ms is timestamp
//             quantisation, not a faster hand.
//  TJ_CONT    a gap below this (or below 2.5x the previous gap, up to TJ_CONT_MAX) is the hand still
//             moving, played over its real length; a longer one is a pause, and the next tick starts
//             afresh with TJ_WAIT.
const TJ_WAIT = 0.0065, TJ_SINGLE = 0.010, TJ_MIN = 0.001, TJ_CONT = 0.05, TJ_CONT_MAX = 0.15;
// TJ_AVG: a continuing segment is paced by the mean of the last 3 gaps. The ticks' timestamps sit
// on a 1 ms USB clock, so a hand at ~1x shows gaps of 2, 3, 2, 3 ms and single-gap pacing flips the
// pitch 0.8x/1.25x per tick: measured on the capture's real nudges, 390-730 cents RMS of tick-rate
// flutter; 3 gaps 270-415 (4: 240-400 but later stops). Every tick position is still passed exactly.
const TJ_AVG = 3;
class Scratch extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.deckId = (options && options.processorOptions && options.processorOptions.deckId) || 'A';
    this.pcm = null;     // this deck's { gL, gR, length, pcmScale } — refreshed once per block
    this.pos = 0;        // fractional read pointer (samples)
    this.target = 0;     // latest platter position from the UI (samples)
    this.step = 0;       // per-sample velocity for the current segment (samples)
    this.curStep = 0;    // lightly smoothed step → clean pitch across segments
    this.since = 0;      // output samples since the last 'move' (measures cadence)
    this.interval = 0;   // samples between the last two 'move's (segment length)
    this.accDt = 0;      // wall-clock banked since the last re-pace (see the 'move' handler)
    this.repace = false; // did this update carry enough elapsed time to recompute the step?
    this.active = false;
    this.gain = 0;       // declick envelope
    this.gainTarget = 0;
    this.lp = [[0, 0], [0, 0]]; // anti-alias lowpass state (2 stages × 2 channels)
    this.lpA = 1;        // current lowpass coefficient (1 = open / no filtering)
    this.nominal = Math.round(sampleRate / 60); // expected samples per UI frame
    this.kStep = 1 - Math.exp(-1 / (0.005 * sampleRate)); // ~5 ms pitch smoothing
    this.kGain = 1 - Math.exp(-1 / (0.004 * sampleRate)); // ~4 ms declick
    // GRANULAR fast-scrub: a continuous resampler can only walk through every sample,
    // so a fast/zoomed-out drag (the finger covering minutes of audio) rate-limits to
    // a multi-second 32× "spin" that LAGS the finger. The fix every pro scrubber uses:
    // once the finger outruns continuous playback, the playhead TRACKS THE FINGER with
    // no lag (uncapped) and we voice short ~1×-pitch Hann grains at the live position —
    // overlap-added two at a time — so you hear the song's sections fly past locked to
    // your hand (Pro Tools scrub / Serato needle-search / granular synthesis, grains
    // ~10–50 ms). Slow/medium scrubbing stays the crisp continuous resampler below.
    this.granular = false;
    this.glen = Math.round(sampleRate * 0.045); this.glen -= this.glen % 2; // ~45 ms grain
    this.gh = this.glen >> 1; // 50% hop/overlap
    this.gwin = new Float32Array(this.glen);
    for (let i = 0; i < this.glen; i++) this.gwin[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.glen);
    this.phaseA = 0; this.startA = 0; this.startB = 0; // two staggered grain heads
    this.stepRaw = 0; this.curRaw = 0; // uncapped finger-tracking velocity
    // Per-stem-group live gain (mute/level knob), same 'stemGain' message + index convention
    // as stretchWorklet's own this.gain_ — kept independently rather than read off the shared
    // PCM registry entry, since the registry only carries the PCM itself, not live mixer state.
    // Defaults to unity (not stretchWorklet's post-load 0-for-unused-slots reset, which scratch
    // has no equivalent load event to hook) — readCh only ever sums up to groups.length anyway,
    // so an untouched slot beyond the real group count is simply never read.
    this.gain_ = new Float32Array([1, 1, 1, 1]);
    // Worklet-OWNED motor ramp (brake / spinback / soft-start): the read velocity glides
    // exponentially toward a target at AUDIO rate instead of being re-posted as positions
    // ~60x/s. That kills the stair-step on the pitch glide (Mixxx drives its scratch at a
    // 1 kHz timer; here it's per output sample). Reports position back for the visual playhead.
    this.ramping = false; this.rampTarget = 0; this.rampTau = 0.1; this.rampSince = 0;
    this.rampLoopStart = -1; this.rampLoopEnd = -1; // -1,-1 = no active loop (ramp runs to the track edge)
    this.rampServo = true; this.rampA = 0; this.rampZ = 0; // servoStep / brakeFriction state
    // HAND TRAJECTORY state (see the move handler): a queue of { to, dur } segments in samples,
    // dur -1 = a first tick still waiting to learn its pace (at = when it arrived, on this.clk).
    this.clk = 0;          // output samples processed, the worklet's own clock
    this.traj = false; this.tjQ = []; this.tjFrom = 0; this.tjEl = 0; this.tjLastT = -1; this.tjGap = 0; this.tjGuess = false;
    this.tjWait = TJ_WAIT * sampleRate; this.tjSingle = TJ_SINGLE * sampleRate; this.tjMin = TJ_MIN * sampleRate;
    this.tjCont = TJ_CONT * sampleRate; this.tjContMax = TJ_CONT_MAX * sampleRate;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'start') {
        // A grab mid-motor-curve (brake/spinback/soft-start) must cancel the ramp, or the
        // audio-rate physics kept running underneath the new grab until IT converged on its
        // own — process()'s ramping branch (it early-continues per sample) runs before any
        // of the code below ever gets to read the fresh pos/step this message just set. The
        // JS side (JogEngine.scrubBegin/onScratchMessage) already re-grabs unconditionally; this was
        // the one place the worklet didn't follow.
        this.ramping = false;
        this.pos = this.target = d.pos;
        this.step = this.curStep = 0;
        this.granular = false; this.curRaw = 0; // a fresh grab always starts continuous
        this.since = 0;
        this.interval = this.nominal;
        this.accDt = 0; // a fresh grab must not inherit the previous gesture's cadence
        this.repace = false;
        this.onset = 0; // samples of first-motion window left (see the move handler)
        this.trkH = []; this.trkT = 0; this.trkTs0 = -1; this.micro = false; this.restPos = d.pos; this.quiet = 1e9; this.lastGap = 0; this.steadyRun = false; // see the micro jog notes
        this.traj = false; this.tjQ.length = 0; this.tjLastT = -1; this.tjGap = 0; this.tjGuess = false; this.tjEl = 0;
        this.lp[0][0] = this.lp[0][1] = this.lp[1][0] = this.lp[1][1] = 0;
        this.lpA = 1;
        this.active = true;
        this.gainTarget = 1;
      } else if (d.type === 'move') {
        // Set the velocity that walks the pointer from where it actually is to the
        // new platter position over ~one update interval. Using the real elapsed
        // interval (not a guess) keeps the motion smooth and drift-free; computing
        // it from the POSITION delta (not the sent velocity) removes the jitter.
        //
        // ★ COALESCE, DON'T SMOOTH. The interval paces the chase from where the read head IS to
        // the new platter position, so it has to be the real time between updates.
        //
        // Two ways to get that wrong, and this code has had both. Using the worklet's own "since"
        // counter fails on BURSTY input: it only advances during process(), so several updates
        // delivered inside one ~2.9ms render quantum all read since=0 and fall back to a fixed
        // ~16.7ms guess — ~4x too slow (measured on a real DDJ-FLX4 capture, where a third of
        // consecutive jog ticks land in the same quantum). Reading too slow drags the pitch down
        // and pins the smoothing tau at its slowest.
        //
        // Replacing it with an EMA of the caller's wall-clock gap fixed the hardware jog and broke
        // the pointer. Mouse and touch also burst — the browser can deliver several pointermoves
        // in one frame — and there the EMA pulls the interval DOWN toward those sub-millisecond
        // gaps while the position delta is still a whole frame's worth. Dividing a full delta by a
        // fraction of its time reads too FAST. So the estimate now oscillates around the truth
        // instead of sitting under it: same wrong-velocity fault, opposite sign, which is why the
        // scratch changed character on mouse AND touch rather than going quiet.
        //
        // The fix is neither. Sub-quantum updates carry no new TIMING information, only a newer
        // position — so take the position and bank the time, and recompute the step only once a
        // real interval has actually elapsed. Numerator and denominator then always describe the
        // same stretch of wall clock, which is the property both broken versions gave up.
        // ★ BUT A MOVE FROM REST HAS NOTHING TO WAIT FOR. Operator: micro jogs "feel laggy on first
        // touch". The banking above held the first tick after a still platter until MIN_INTERVAL
        // of input time had passed, i.e. until the next ~60 Hz settle post, and only THEN chased
        // over that whole interval: 30-48 ms to cover half of a 1-4 tick nudge (measured on this
        // worklet). From rest there is no previous pace to protect, so pace it at once over
        // MIN_INTERVAL; the following posts re-pace from real timing as usual.
        const fromRest =
          (this.step < 0 ? -this.step : this.step) < 1e-3 &&
          (this.curStep < 0 ? -this.curStep : this.curStep) < 1e-3 &&
          Math.abs(this.target - this.pos) < 1 &&
          Math.abs(d.pos - this.target) >= 1;
        // Inside that first MIN_INTERVAL (the ONSET) every tick re-aims at once too: a nudge is
        // usually a burst of 3-8 ticks inside a few ms, and banking ticks 2..n left the head chasing
        // only the first one until the next settle post.
        const dtIn = d.dtMs > 0 ? (d.dtMs * sampleRate) / 1000 : 0;
        // ★ ARRIVAL STOP (operator, 2026-11-03: micro jogs "still need work for the slurry feel and
        // sound"). The glide keeps its last pace until the NEXT message, and after a nudge the next
        // message is the ~60 Hz settle post: the head ran past where the hand stopped by 23-59% of
        // the nudge, then re-paced BACKWARD to it, and took 110-190 ms to settle (measured on this
        // source by scripts/joglab/microjog.mjs). A forward-then-back slide the hand never made.
        // Stopping at the target ALWAYS cured that and wrecked ordinary scratching (touch roughness
        // 0.048 → 0.327, board trips 10 → 30): mid-gesture the head meets each target just as the
        // next update is due, and parking whenever one is late is a stutter. And "a repeated
        // position means the hand is still" is not reliable either: 60 Hz touch gets settle posts
        // between ordinary moves. So the stop is scoped to what a micro jog IS: motion that started
        // from rest and has not travelled further than MICRO_SPAN from there. A scratch leaves that
        // span within its first stroke and runs exactly the original glide from then on.
        const rel = (d.pos - this.restPos) / sampleRate;
        // A GENUINE rest: no real movement reported for ~33 ms. Without this the stop below
        // re-armed itself: it leaves the head exactly at rest, so the next ordinary 60 Hz touch move
        // looked like a move from rest and the whole gesture became a string of stops.
        // ★ A SLOW, STEADY TURN IS NOT A STRING OF NUDGES. Operator, 2026-11-03: the paused outer
        // ring is "kind of choppy instead of giving me micro adjustment". A slowly turned ring sends
        // sparse, evenly spaced ticks (20-60 ms apart), and each one reached the head at rest, so
        // each got the fast first-touch pacing: cover the tick in 13 ms, then park until the next.
        // Measured (microjog.mjs ring search): parked 9-67% of the turn, speed spread 0.45-1.64×.
        // A tick that arrives on the rhythm of the ones before it (within 2.5× the last gap, under
        // 150 ms) is CONTINUING motion: pace it over that gap, so the head arrives as the next tick
        // does and glides at the ring's own speed. A tick after real stillness keeps the fast onset.
        // (> 20 ms: only SPARSE input. 60 Hz touch reaches "rest" between ordinary moves ~17 ms
        // apart, and pacing those as a slow turn cost touch scratching its alignment — measured.)
        const steady = fromRest && this.lastGap > 0 && this.quiet > 960 && this.quiet < 2.5 * this.lastGap && this.quiet < 7200;
        if (fromRest && !steady && this.quiet > 1600) {
          this.micro = true; this.restPos = this.target;
          this.traj = !!d.hw; this.tjQ.length = 0; this.tjFrom = this.pos; this.tjTo = this.target; this.tjEl = 0; this.tjLastT = -1; this.tjGap = 0; this.tjGuess = false;
          this.granular = false; this.steadyRun = false;
        }
        else if (this.micro && (rel > MICRO_SPAN || rel < -MICRO_SPAN)) this.micro = false;
        if (d.pos !== this.target) { this.lastGap = this.quiet < 1e8 ? this.quiet : 0; this.quiet = 0; }
        if (!this.granular && d.pos === this.target) {
          // ★ A SETTLE POST (grabTick re-posting the held position) NEVER HURRIES THE HEAD. It used
          // to re-pace the remaining distance over the time since the last re-pace, so between two
          // slow ticks the head was rushed onto the last one and parked: the other half of the
          // choppiness. It carries no new position, so: if the head already went past the hand,
          // stop where it is (no slide back, see ARRIVAL STOP); if it is still heading there at its
          // own pace, just bank the time; only a head stopped short is re-paced, as before.
          // Both are SCOPED, and measured to need it: applied to every gesture, the hold took board
          // roughness 0.044 → 0.090 and the real FLX4 capture 0.173 → 0.250, and the banking alone
          // still cost 60 Hz touch scratching (0.049 → 0.058, worse alignment). So the hold is for
          // a micro jog and the banking for a steady slow turn; anything else runs the old pacing.
          // (A controller micro jog never runs past the hand at all: it plays the hand's trajectory
          // and holds on its last tick, so a settle post has nothing to correct there.)
          const ahead = (this.pos - this.target) * this.curStep;
          if (this.micro && !this.traj && ahead > 0) { this.target = this.pos; this.step = this.curStep = 0; this.since = 0; return; }
          if (!this.traj && this.steadyRun && (this.target - this.pos) * this.curStep > 0) { this.accDt += dtIn; this.since = 0; return; }
        }
        if (steady) {
          this.interval = Math.max(MIN_INTERVAL, Math.min(7200, this.lastGap)); // lastGap = this tick's gap (set above)
          this.accDt = 0;
          this.onset = 0;
          this.repace = true;
          this.steadyRun = true;
        } else if (fromRest) {
          this.steadyRun = false;
          this.interval = MIN_INTERVAL;
          this.accDt = 0;
          this.onset = MIN_INTERVAL;
          this.repace = true;
        } else if (this.onset > 0 && (this.onset -= dtIn) > 0) {
          this.interval = MIN_INTERVAL;
          this.accDt = 0;
          this.repace = true;
        } else {
          this.onset = 0;
          const dtSamples = d.dtMs > 0 ? (d.dtMs * sampleRate) / 1000 : 0;
          this.accDt += dtSamples > 0 ? dtSamples : (this.since > 0 ? this.since : 0);
          if (this.accDt >= MIN_INTERVAL || this.interval <= 0) {
            this.interval = Math.max(1, this.accDt > 0 ? this.accDt : this.nominal);
            this.accDt = 0;
            this.repace = true;
          } else {
            this.repace = false; // same quantum: newer target, same pacing
          }
        }
        this.since = 0;
        this.target = d.pos;
        // A sub-quantum update moves the TARGET (the chase always aims at the latest position)
        // but leaves the pacing alone — there is no new timing to pace with yet.
        // ★ SPEED FROM A TRACKER, NOT FROM TICKS COUNTED PER WINDOW (operator, 2026-11-10: a steady
        // jog spin gave "wobble, warp and weird ugly noises, not the playback"; picked this by ear
        // from scripts/joglab/scratchwav.mjs, render p4-proposed). The step used to be "distance
        // since the last re-pace ÷ that window". A steady 1x FLX4 turn sends a tick every 2.5 ms on
        // a 1 ms USB clock, so a ~13 ms window held 5 or 6 ticks and the speed flipped ~0.9x/1.1x:
        // 4.1% RMS flutter at ~25 Hz (18.7% with main-thread delivery jitter). Now every move — tick
        // or settle post — is a (time, position) sample timed by d.ts (the controller's own
        // MIDIMessageEvent.timeStamp, else the post time), the speed is the least-squares slope over
        // the last 24 ms of them, and the gap between the fitted hand and the read head is pulled
        // in over ~200 ms, so the head never drifts off the platter but no single tick jerks the
        // pitch: 0.26% (0.36% under jitter). A stopped hand's settle posts read as speed 0.
        {
          if (!this.trkH) this.trkH = [];
          if (typeof d.ts === 'number') {
            if (this.trkTs0 < 0) this.trkTs0 = d.ts;
            this.trkT = ((d.ts - this.trkTs0) * sampleRate) / 1000;
          } else {
            this.trkT = (this.trkT || 0) + dtIn;
          }
          const H = this.trkH;
          H.push(this.trkT, d.pos);
          const win = 0.024 * sampleRate;
          while (H.length > 4 && this.trkT - H[0] > win) H.splice(0, 2);
          const n = H.length / 2;
          let st = 0, sp = 0, stt = 0, stp = 0;
          for (let i = 0; i < H.length; i += 2) {
            const t = H[i] - this.trkT, p = H[i + 1] - d.pos;
            st += t; sp += p; stt += t * t; stp += t * p;
          }
          const den = n * stt - st * st;
          const v = den > 1e-6 ? (n * stp - st * sp) / den : 0;
          const fit = d.pos + (sp - v * st) / n; // the fitted hand position NOW
          this.trk = v + (fit - this.pos) / (0.2 * sampleRate);
        }
        // ★ HAND TRAJECTORY: A MICRO JOG PLAYS WHAT THE HAND DID (operator, 2026-11-10: micro jogs
        // sounded like "little raygun pew pews... R2D2 bird whines... smeary and low pitch"; asked for
        // "physical parity"). A record moved N ticks plays exactly those N x 2.5 ms of audio over
        // exactly the time the finger took. The chase above paced every nudge from rest over a fixed
        // ~13 ms, so a 2-4 tick flick the hand made at ~2.5x came out as a flat 0.37-0.72x plateau and
        // a stop (scripts/joglab/scratchwav.mjs): low, smeared, the same for every nudge. Now a micro
        // jog is played piecewise-linearly through the tick positions, each tick-to-tick segment
        // over its REAL gap (tracker clock: the controller's own tick timestamps), one segment behind
        // the hand: the head starts a segment once its end tick is known. The first tick after rest
        // has no start time; it waits up to TJ_WAIT for the second and takes that gap, else it plays
        // over TJ_SINGLE (and is re-timed if the second tick comes while it plays). It holds exactly
        // on the last tick when no more come (settle posts add nothing), and hands over to the
        // tracker once the motion leaves MICRO_SPAN, with the head's speed carried into the ease.
        // Only for CONTROLLER ticks (d.hw: JogEngine got the tick's own timestamp). Pointer input
        // coalesces several events into one post time, so its gaps are not the hand's; it keeps
        // the chase pacing and the ARRIVAL STOP (measured: as a trajectory, mouse roughness doubled).
        // Measured on the capture's real nudges (scratchwav.mjs 04-capture-micro): the head starts
        // 4-8 ms after the first tick (the first gap, or TJ_WAIT), and stops 9-30 ms after the last.
        if (this.traj) {
          if (this.micro) {
            if (d.pos !== this.tjTo) this.tjTick(d.pos, this.trkT);
            return;
          }
          this.traj = false; this.tjQ.length = 0; this.tjGuess = false;
          this.onset = 0; this.accDt = 0; this.interval = MIN_INTERVAL; this.repace = true;
        }
        if (!this.repace) return; // keep the current step; the next re-pace will use the banked time
        // The tracker drives CONTINUING motion. A move from rest (the onset) and a pointer micro jog
        // keep the chase pacing their own tests were tuned on: 24 ms of history is nothing to fit at
        // the first tick, and the tracker's ~200 ms pull would overrun a nudge's stop. (A controller
        // micro jog is the trajectory above.)
        this.stepRaw = this.micro || this.onset > 0 || fromRest
          ? (this.target - this.pos) / this.interval
          : this.trk; // uncapped (granular tracks the finger)
        let s = this.stepRaw;
        if (s > 32) s = 32; else if (s < -32) s = -32; // continuous resampler clamp
        this.step = s;
        // Switch to granular when the finger outruns continuous playback (hysteresis
        // so it doesn't flutter at the boundary).
        // ★ THE TRIGGER WAS 8× AND THAT IS THE "POORLY DONE FF/RW" A JOG SCRATCH SOUNDED LIKE.
        // reqSpeed is the CATCH-UP speed (target − pos over the interval), which overshoots the
        // hand whenever the read head trails it, so ordinary fast strokes crossed 8× and played
        // as 45 ms needle-search grains: 14.5% of the operator's real hands-on scratching at the
        // old window, 8.6% at the new one. A record chirps like vinyl well past 8×; granular is
        // for zoomed-out waveform drags covering MINUTES, which run far faster than any hand on a
        // platter. Entering at 24× (leaving at 16×) took real scratching to 0% granular while
        // those drags still get grains. The continuous resampler is clamped at 32× and
        // anti-aliased, so 8–24× is within what it was built for.
        const reqSpeed = this.stepRaw < 0 ? -this.stepRaw : this.stepRaw;
        if (!this.granular && reqSpeed > 24) {
          this.granular = true;
          this.phaseA = 0; this.startA = this.pos; this.startB = this.pos; this.curRaw = this.stepRaw;
        } else if (this.granular && reqSpeed < 16) {
          this.granular = false; this.curStep = 0;
        }
        // Adapt the pitch-smoothing time constant to the ACTUAL update interval:
        // dense (high-rate, per-input) updates need almost no smoothing → snappy;
        // sparse ~60 Hz updates need more to bridge the gap without a stair-step.
        // Clamp 1…8 ms. (Updates now arrive at the mouse's full report rate.)
        // During the onset the head starts from standstill: a short tau, or the smoothing alone
        // spends ~8 ms ramping up to a speed the nudge only needs for ~13.
        const tau = this.onset > 0 ? 0.002 : Math.min(0.008, Math.max(0.001, (this.interval / sampleRate) * 0.6));
        this.kStep = 1 - Math.exp(-1 / (tau * sampleRate));
      } else if (d.type === 'ramp') {
        // Begin an audio-rate motor ramp. vel = initial read velocity (samples/output-sample,
        // i.e. playback rate: 1 = forward 1x, -8 = 8x reverse), target = where it eases to
        // (0 = stop, the play rate = catch back to play), tau = exp time constant (seconds).
        this.pos = d.pos;
        this.curStep = d.vel;
        this.rampTarget = d.target;
        this.rampTau = Math.max(0.001, d.tau);
        this.rampServo = d.servo; // true = motor servo (spinback/soft-start), false = friction brake
        this.rampA = 0; this.rampZ = 0; // fresh state per ramp — see servoStep/brakeFriction in JogEngine.ts
        this.ramping = true; this.granular = false; this.rampSince = 0; this.traj = false;
        this.active = true; this.gainTarget = 1;
        // loopStart/loopEnd (worklet-local samples), or -1,-1 when the deck has no active
        // loop — a spinback/soft-start ramp that's headed back to play stays inside a live
        // loop instead of throwing the platter out past its edge.
        this.rampLoopStart = d.loopStart; this.rampLoopEnd = d.loopEnd;
      } else if (d.type === 'stop') {
        this.gainTarget = 0; // fade out; go fully idle once silent
        this.ramping = false; // a transport takeover cancels an in-flight ramp
      } else if (d.type === 'stemGain') {
        if (d.index >= 0 && d.index < 4) this.gain_[d.index] = d.value;
      }
    };
  }
  // A micro jog's new tick (position "to", at tracker time T in samples) joins the trajectory queue.
  tjTick(to, T) {
    const known = this.tjLastT >= 0;
    const g0 = known ? T - this.tjLastT : 0;
    this.tjLastT = T;
    this.tjTo = to;
    const g = g0 > this.tjMin ? g0 : this.tjMin;
    const Q = this.tjQ;
    const last = Q.length ? Q[Q.length - 1] : null;
    if (known && last && last.dur < 0) {
      // the second tick came inside the wait: its gap paces the first segment too
      last.dur = g; Q.push({ to, dur: g }); this.tjGap = g0; this.tjH = [g]; return;
    }
    if (known && this.tjGuess && Q.length) {
      // the lone first tick is already playing over its guess: finish it at the real pace, from
      // where the head is now (so the position does not jump, only the speed changes)
      const e = Q[0];
      const left = 1 - this.tjEl / e.dur;
      this.tjFrom = this.tjFrom + (e.to - this.tjFrom) * (this.tjEl / e.dur);
      this.tjEl = 0; e.dur = left * g > 1 ? left * g : 1;
      this.tjGuess = false; Q.push({ to, dur: g }); this.tjGap = g0; this.tjH = [g]; return;
    }
    const cont = known && (this.tjGap > 0 ? g0 < 2.5 * this.tjGap && g0 < this.tjContMax : g0 < this.tjCont);
    if (cont) {
      // paced by the mean of the last TJ_AVG gaps: every tick position is still passed exactly,
      // only the 1 ms USB-frame quantisation of each single gap is averaged out of the pitch
      const H = this.tjH || (this.tjH = []);
      H.push(g); if (H.length > TJ_AVG) H.shift();
      let m = 0; for (let i = 0; i < H.length; i++) m += H[i];
      Q.push({ to, dur: m / H.length }); this.tjGap = g0;
    } else { Q.push({ to, dur: -1, at: this.clk }); this.tjGap = 0; this.tjH = []; }
  }
  // One sample of one output channel (0=L, 1=R) from the shared PCM registry, weighted by
  // this.gain_ per group — the same live per-stem mute/level state stretchWorklet's own
  // playback already reflects (Deck.rampStem posts the identical 'stemGain' message to both
  // nodes now). Used to be an unweighted sum regardless of mute state; that was never a
  // deliberate choice, just nothing had wired the mixer's live gain into scratch's read path.
  // Clamps to the track edges (repeats the edge sample) rather than zero-padding — granular
  // grains can read past either end. Silence (not a crash) when nothing's registered yet.
  readCh(ch, idx) {
    const pcm = this.pcm;
    if (!pcm || pcm.length === 0) return 0;
    const n = pcm.length;
    if (idx < 0) idx = 0; else if (idx > n - 1) idx = n - 1;
    const groups = ch === 0 ? pcm.gL : pcm.gR;
    let s = 0;
    for (let g = 0; g < groups.length; g++) { const ga = this.gain_[g]; if (ga) s += ga * groups[g][idx]; }
    return s * pcm.pcmScale;
  }
  cubic(ch, pos) {
    const i = Math.floor(pos);
    const x = pos - i;
    const s1 = this.readCh(ch, i - 1), s2 = this.readCh(ch, i), s3 = this.readCh(ch, i + 1), s4 = this.readCh(ch, i + 2);
    const c1 = x * (-0.5 + x * (1 - 0.5 * x));
    const c2 = 1 + x * x * (1.5 * x - 2.5);
    const c3 = x * (0.5 + x * (2 - 1.5 * x));
    const c4 = 0.5 * x * x * (x - 1);
    return s1 * c1 + s2 * c2 + s3 * c3 + s4 * c4;
  }
  // Mean of the input samples swept between two read positions = area sampling.
  // When the platter rips across the track, each output sample spans many input
  // samples; averaging them (instead of point-sampling one) is inherently
  // anti-aliased AND tames the energy dump — a fast drag ROLLS instead of
  // collapsing into a harsh aliased swirl.
  boxAvg(ch, a, b) {
    const pcm = this.pcm;
    if (!pcm || pcm.length === 0) return 0;
    const n = pcm.length;
    let i0 = Math.floor(a < b ? a : b);
    let i1 = Math.floor(a < b ? b : a);
    if (i0 < 0) i0 = 0;
    if (i1 > n - 1) i1 = n - 1;
    if (i1 < i0) i1 = i0;
    let sum = 0;
    for (let i = i0; i <= i1; i++) sum += this.readCh(ch, i);
    return sum / (i1 - i0 + 1);
  }
  // Crisp point-sampling for slow/micro scrubbing (≤1 sample/step), area-averaging
  // for fast sweeps, smoothly crossfaded across 1…3× so there's no seam as the
  // platter accelerates. Preserves the sharp micro-scrub feel exactly.
  readScrub(ch, p0, p1, sp) {
    if (sp <= 1) return this.cubic(ch, p1);
    const avg = this.boxAvg(ch, p0, p1);
    if (sp >= 3) return avg;
    const t = (sp - 1) * 0.5; // 0 at 1×, 1 at 3×
    return this.cubic(ch, p1) * (1 - t) + avg * t;
  }
  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;
    const nCh = output.length;
    if (!this.active && this.gain < 1e-4) {
      for (let c = 0; c < nCh; c++) output[c].fill(0);
      return true;
    }
    this.pcm = globalThis.__htlPcm.get(this.deckId); // refresh once per block — see module-scope note above
    const last = (this.pcm ? this.pcm.length : 0) - 1;
    // Anti-aliasing: reading faster than 1× is decimation, so source energy above
    // the new Nyquist (= Nyquist/speed) folds back as harsh metallic alias. Lowpass
    // with a cutoff that tracks 1/speed; below 1× the filter opens (no aliasing).
    const speed = Math.abs(this.curStep);
    const targetA = speed > 1 ? 1 - Math.exp(-Math.PI / speed) : 1;
    this.lpA += (targetA - this.lpA) * 0.25; // smooth the cutoff to avoid zipper
    const a = this.lpA;
    const glen = this.glen, gh = this.gh, gwin = this.gwin;
    for (let i = 0; i < frames; i++) {
      this.since++; this.clk++;
      this.gain += (this.gainTarget - this.gain) * this.kGain;
      if (this.ramping) {
        // Motor ramp: ease the read velocity toward the target every sample. Two DIFFERENT
        // physical processes, not one curve (kept in sync by hand with servoStep/brakeFriction
        // in JogEngine.ts; a worklet can't import a TS module — see the design notes there).
        if (this.rampServo) {
          // Catch-up-to-play: a torque-driven 2nd-order servo step response, anchored to the
          // real Technics SL-1200 spec (0.7s standstill-to-speed) — omegaN*tau ~= 6.64 at
          // zeta=1.05 reproduces that, verified by simulation across this exact dt range.
          const omegaN = 6.64 / this.rampTau;
          const accel = omegaN * omegaN * (this.rampTarget - this.curStep) - 2 * 1.05 * omegaN * this.rampA;
          this.rampA += accel * (1 / sampleRate);
          this.curStep += this.rampA * (1 / sampleRate);
        } else {
          // Brake: a simplified LuGre friction/stiction model. Fs/Fc=1.15 is real felt
          // tribology data (AlphaTheta's own jog-tension pads are felt, EP3989600A1).
          const v = this.curStep;
          if (v !== 0) {
            const fc = 0.3 * this.rampTau;
            const fs = 1.15 * fc;
            const g = fc + (fs - fc) * Math.exp(-((v / 0.15) ** 2));
            const zdot = v - (Math.abs(v) * this.rampZ) / g;
            this.rampZ += zdot * (1 / sampleRate);
            const sigma0 = 8 / (0.3 * this.rampTau);
            const sigma2 = 1 / this.rampTau;
            const F = sigma0 * this.rampZ + sigma2 * v;
            const next = v - F * (1 / sampleRate);
            if (next > 0 !== v > 0) { this.curStep = 0; this.rampZ = 0; } else { this.curStep = next; }
          }
        }
        let done = (this.curStep - this.rampTarget) * (this.curStep - this.rampTarget) < 0.0004; // within 0.02
        const p0 = this.pos;
        this.pos += this.curStep;
        let seam = false; // a loop wrap just cut the pointer — don't span-read across it
        if (this.rampLoopEnd > this.rampLoopStart) {
          const ls = this.rampLoopStart, le = this.rampLoopEnd, ln = le - ls;
          if (this.pos >= le) { this.pos = ls + (this.pos - le) % ln; seam = true; }
          else if (this.pos < ls) { this.pos = le - (ls - this.pos) % ln; seam = true; }
        } else {
          if (this.pos < 0) { this.pos = 0; done = true; }
          else if (this.pos > last) { this.pos = last; done = true; }
        }
        const sp = this.curStep < 0 ? -this.curStep : this.curStep;
        const rp0 = seam ? this.pos : p0;
        for (let c = 0; c < nCh; c++) {
          const s = this.readScrub(c, rp0, this.pos, sp);
          const st = this.lp[c] || (this.lp[c] = [0, 0]);
          st[0] += a * (s - st[0]);
          st[1] += a * (st[0] - st[1]);
          output[c][i] = st[1] * this.gain;
        }
        if (++this.rampSince >= this.nominal) { this.rampSince = 0; this.port.postMessage({ type: 'rampPos', pos: this.pos }); }
        if (done) { this.ramping = false; this.gainTarget = 0; this.port.postMessage({ type: 'rampDone', pos: this.pos }); }
        continue;
      }
      if (this.granular) {
        // Follow the finger UNCAPPED (no multi-second catch-up) …
        this.curRaw += (this.stepRaw - this.curRaw) * this.kStep;
        this.pos += this.curRaw;
        if (this.pos < 0) this.pos = 0; else if (this.pos > last) this.pos = last;
        // … and voice two overlapping ~1×-pitch grains anchored to the live position.
        let pa = this.phaseA;
        if (pa >= glen) { pa = 0; this.startA = this.pos; }
        if (pa === gh) this.startB = this.pos; // B re-anchors when its window restarts
        let pb = pa + gh; if (pb >= glen) pb -= glen;
        const wA = gwin[pa], wB = gwin[pb];
        for (let c = 0; c < nCh; c++) {
          output[c][i] = (wA * this.cubic(c, this.startA + pa) + wB * this.cubic(c, this.startB + pb)) * this.gain;
        }
        this.phaseA = pa + 1;
        continue;
      }
      // Continuous resampler (vinyl): GLIDE the read pointer at the platter's MEASURED
      // velocity (curStep eased toward the per-interval step = Δposition / Δtime). This
      // fills the whole gap between sparse position updates, so it never parks. A position-
      // TRACKING filter instead (the old alpha-beta, or a feed-forward + position trim)
      // sees the full inter-update advance as error and rushes the pointer to the target in
      // ~1 ms, then stalls for the rest of the gap — at 60-125 Hz (touch / many mice) that
      // stall is the stutter / DC-buzz that distorted the scrub. Pure feed-forward needs no
      // position correction: each 'move' recomputes step from the ACTUAL current pos, so
      // any drift self-nulls within one update with no built-in convergence stall.
      const p0 = this.pos;
      this.quiet++;
      if (this.traj) {
        // A micro jog: walk the hand's trajectory (see HAND TRAJECTORY in the move handler). Each
        // segment ends exactly on its tick; with the queue empty the head holds on the last one.
        const Qe = this.tjQ;
        let e = Qe.length ? Qe[0] : null;
        if (e && e.dur < 0 && this.clk - e.at >= this.tjWait) { e.dur = this.tjSingle; this.tjGuess = true; this.tjEl = 0; }
        if (e && e.dur > 0) {
          this.tjEl += 1;
          while (e && e.dur > 0 && this.tjEl >= e.dur) {
            this.tjEl -= e.dur; this.tjFrom = e.to; Qe.shift(); this.tjGuess = false;
            e = Qe.length ? Qe[0] : null;
            if (e && e.dur < 0) {
              if (this.clk - e.at >= this.tjWait) { e.dur = this.tjSingle; this.tjGuess = true; }
              this.tjEl = 0;
            }
          }
          if (!e || e.dur < 0) this.tjEl = 0;
          this.pos = e && e.dur > 0 ? this.tjFrom + (e.to - this.tjFrom) * (this.tjEl / e.dur) : this.tjFrom;
        }
        this.curStep = this.step = this.pos - p0;
      } else {
        this.curStep += (this.step - this.curStep) * this.kStep; // ease toward target velocity
        if (this.curStep > 32) this.curStep = 32; else if (this.curStep < -32) this.curStep = -32;
        this.pos += this.curStep; // feed-forward glide (fills the inter-update gap, no parking)
        if (this.micro && this.curStep !== 0) {
          // A pointer micro jog lands ON the hand's position and stops there (see ARRIVAL STOP).
          const r0 = this.target - p0, r1 = this.target - this.pos;
          if (r0 * r1 < 0 || r1 === 0) { this.pos = this.target; this.curStep = 0; this.step = 0; }
        }
      }
      if (this.pos < 0) { this.pos = 0; if (this.curStep < 0) this.curStep = 0; }
      else if (this.pos > last) { this.pos = last; if (this.curStep > 0) this.curStep = 0; }
      const sp = this.curStep < 0 ? -this.curStep : this.curStep;
      for (let c = 0; c < nCh; c++) {
        const s = this.readScrub(c, p0, this.pos, sp);
        const st = this.lp[c] || (this.lp[c] = [0, 0]);
        st[0] += a * (s - st[0]);       // two cascaded one-poles clean the residual sidelobes
        st[1] += a * (st[0] - st[1]);
        output[c][i] = st[1] * this.gain;
      }
    }
    if (this.gainTarget === 0 && this.gain < 1e-3) this.active = false;
    return true;
  }
}
registerProcessor('scratch', Scratch);
`;
