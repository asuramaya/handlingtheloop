// A MULTI-DEVICE SESSION, SIMULATED — two (or more) devices, one wire, the real apply path.
//
// The question this exists to ask: *when I do something here, does the same thing happen there?*
// Every multi-device bug this app has had is a "no" to that question, and they all rhyme — an
// index, an id or a focus that meant one thing on the sender and something else on the receiver.
// A slot number computed against MY rack. A chain id that is a per-deck sequence number. A
// transition that drives the decks directly and never reaches the wire at all.
//
// ★ WHAT IS REAL HERE AND WHAT IS NOT. The receiving path is REAL: intents go through
// applyIntent.ts, the same function the app runs. The board bus is REAL: gestures go through the
// registry in boardActions.ts. What is simulated is the DECK — and specifically its FX ADDRESS
// SPACE, which is modelled exactly as FxRack does it (`allDevices` = chains flat-mapped, stem
// chains first, then the master), because that address space IS the thing under test. No audio is
// simulated and none is claimed: a green test here says "both devices agree on which device the
// gesture named", never "it sounded right".

import { applyBoardAction } from "../board/boardActions";
import { rackDelta } from "../audio/fxSnapshotReconcile";
import type { Deck } from "../audio/Deck";
import { applyIntent, type IntentDeck, type IntentEngine, type IntentHost } from "./applyIntent";
import { LoopEngine, type LoopEdit } from "../audio/LoopEngine";
import { nearestBeat, type Beatgrid } from "../analysis/analyze";
import { loopEditIntent } from "./loopWire";
import { isApplyingRemote } from "./remoteApply";
import { isRoleEcho, keyStateIntents, shouldAnnounceAutoRole, syncStateIntents, SYNC_ECHO_TEMPO_EPS, type AutoRoleCause } from "./syncRoles";

type BoardDeck = Deck;
import type { DeckId, FxChainSlot, FxSlot, Intent, StemName } from "./protocol";

export interface SimDeviceState {
  kind: string;
  params: Record<string, number>;
  bypassed: boolean;
}
export interface SimChain {
  id: string;
  name: string;
  master: boolean;
  stems: number;
  devices: SimDeviceState[];
}

/** The deck the simulator drives. Holds every piece of state an intent can move, so a test can
 *  compare two devices field by field rather than trusting that "it applied". */
export class FakeDeck implements IntentDeck {
  // Chain ids are per-deck sequence numbers — exactly as the real Deck mints them, because the
  // fact that they DON'T match across devices is half of what this harness is here to catch.
  private seq = 1;
  chains: SimChain[] = [{ id: "master", name: "Master", master: true, stems: 0, devices: [] }];
  eq: Record<string, number> = {};
  toggles: Record<string, boolean> = {};
  stemGains: Record<string, number> = {};
  stemMutes: Record<string, boolean> = {};
  tempo = 0;
  trim = 1;
  level = 1;
  filter = 0;
  pitch = 0;
  playing = false;
  /** The playhead (seconds). A FIELD here so a test can put two devices at different places; the
   *  Deck-shaped reader is position(). */
  pos = 0;
  position(): number {
    return this.pos;
  }
  skipBeats = 4;
  // ★ THE LOOP / CUE STATE IS THE REAL LoopEngine (operator, 2026-11-11: session sync audit). A fake
  // that stored whatever arrived could not show that a re-run at the receiver's playhead, on the
  // receiver's grid and quantize flag, lands somewhere else, which was the whole bug. The engine runs
  // against this deck's own playhead, grid (`grid`) and quantize toggle, exactly as on a device.
  grid: Beatgrid | null = null;
  duration = 300;
  /** Where the un-wrapped clock would be (rollOut's snap-back target); a test sets it. */
  raw = 0;
  /** Set by SimDevice: the deck reports a LOCAL loop mutation, as Deck.onLoopEdit does in the app. */
  onLoopEdit?: (edit: LoopEdit) => void;
  readonly loops = new LoopEngine({
    position: () => this.pos,
    seek: (t) => this.seek(t),
    reanchorClock: () => {},
    rebaseClock: () => {},
    rawOffset: () => this.raw,
    postLoop: () => {},
    beatgrid: () => this.grid,
    duration: () => this.duration,
    playing: () => this.playing,
    loaded: () => true,
    quantize: () => !!this.toggles.quantize,
    onLoopEdit: (edit) => this.onLoopEdit?.(edit),
  });
  get cuePoint() { return this.loops.cuePoint; }
  set cuePoint(v: number) { this.loops.cuePoint = v; }
  get loop() { return this.loops.loop; }
  get loopInPoint() { return this.loops.loopInPoint; }
  get hotCues() { return this.loops.hotCues; }
  get hotLoops() { return this.loops.hotLoops; }
  /** Every gesture that reached this deck, in order — the receipt a failure is read off. */
  log: string[] = [];
  // Enough of the transport/analysis surface for the REAL SmartFader to run against this deck.
  beatgrid: { bpm: number } | null = null;
  keylock = false;
  keylockPinnedOff = false;
  get effectiveBpm(): number {
    return (this.beatgrid?.bpm ?? 0) * (1 + this.tempo / 100);
  }
  setKeylockPinnedOff(on: boolean) {
    this.keylockPinnedOff = on;
  }

  // --- the FX address space, modelled exactly as FxRack does it -------------------------------
  /** Stem chains first, then the master — the index space `slot` walks. */
  get allDevices(): SimDeviceState[] {
    return this.chains.flatMap((c) => c.devices);
  }
  addChain(name: string, stems = 0): SimChain {
    const c: SimChain = { id: `c${this.seq++}`, name, master: false, stems, devices: [] };
    this.chains.splice(this.chains.length - 1, 0, c); // master stays last
    return c;
  }
  addDevice(chainId: string, kind: string, params: Record<string, number> = {}): SimDeviceState {
    const c = this.chains.find((x) => x.id === chainId);
    if (!c) throw new Error(`no chain ${chainId}`);
    const d: SimDeviceState = { kind, params: { ...params }, bypassed: false };
    c.devices.push(d);
    return d;
  }
  /** The portable address of a slot, exactly as the real Deck computes it. */
  fxWireAddrAt(slot: number): { chain: string; fx: string } | undefined {
    const a = this.addrAt(slot);
    return a ? { chain: a.chain, fx: a.kind } : undefined;
  }
  /** The master chain, as `fxSnapshot()` has always served it. */
  fxSnapshot(): FxSlot[] {
    return this.chains[this.chains.length - 1].devices.map((d) => ({ kind: d.kind, bypassed: d.bypassed, params: { ...d.params } }));
  }
  /** The stem chains — what `fxRack` never carried. */
  fxChainsForWire(): FxChainSlot[] {
    return this.chains.filter((c) => !c.master).map((c) => ({ name: c.name, stems: c.stems, devices: c.devices.map((d) => ({ kind: d.kind, bypassed: d.bypassed, params: { ...d.params } })) }));
  }
  /** Which chain+kind a flat slot resolves to HERE — the answer that has to match across devices. */
  addrAt(slot: number): { chain: string; kind: string } | undefined {
    const d = this.allDevices[slot];
    if (!d) return undefined;
    const c = this.chains.find((x) => x.devices.includes(d));
    return c ? { chain: c.name, kind: d.kind } : undefined;
  }
  deviceAt(chainName: string, kind: string): SimDeviceState | undefined {
    return this.chains.find((c) => c.name === chainName)?.devices.find((d) => d.kind === kind);
  }

  setFxParam(slot: number, param: string, value: number): void {
    const d = this.allDevices[slot];
    this.log.push(`fxParam ${slot} ${param}=${value} → ${d ? `${this.addrAt(slot)!.chain}/${d.kind}` : "NOWHERE"}`);
    if (d) d.params[param] = value;
  }
  setFxBypass(slot: number, value: boolean): void {
    const d = this.allDevices[slot];
    this.log.push(`fxBypass ${slot}=${value} → ${d ? d.kind : "NOWHERE"}`);
    if (d) d.bypassed = value;
  }
  /** Same resolution the real Deck does: chain by NAME, device by kind, -1 when absent. */
  fxSlotOf(chain: string, fx: string): number {
    const d = this.deviceAt(chain, fx);
    return d ? this.allDevices.indexOf(d) : -1;
  }
  /** Rebuild the stem chains by name, mirroring Deck.applyFxChainSnapshot — including its rule
   *  that `undefined` leaves what is there alone rather than destroying it. */
  /** Counts how many times the chains were REBUILT rather than written in place — the simulator's
   *  way of seeing an audio-destroying teardown, which has no other visible effect. */
  chainRebuilds = 0;
  applyFxChains(chains: ReadonlyArray<FxChainSlot> | undefined): void {
    if (!chains) return;
    const live = this.chains.filter((c) => !c.master);
    const sameShape =
      live.length === chains.length &&
      live.every((c, i) => c.name === chains[i].name && c.stems === (chains[i].stems ?? 0) && c.devices.length === chains[i].devices.length && c.devices.every((d, j) => d.kind === chains[i].devices[j].kind));
    if (sameShape) {
      chains.forEach((c, i) => c.devices.forEach((sd, j) => {
        live[i].devices[j].params = { ...sd.params };
        live[i].devices[j].bypassed = !!sd.bypassed;
      }));
      return;
    }
    this.chainRebuilds++;
    const master = this.chains[this.chains.length - 1];
    this.chains = [
      ...chains.map((c) => ({
        id: `c${this.seq++}`,
        name: c.name,
        master: false,
        stems: c.stems ?? 0,
        devices: c.devices.map((d) => ({ kind: d.kind, params: { ...(d.params ?? {}) }, bypassed: !!d.bypassed })),
      })),
      master,
    ];
    this.log.push(`fxChains ${chains.map((c) => c.name).join(",")}`);
  }
  applyFxSnapshot(rack: FxSlot[]): void {
    // ★ THIS COMMENT USED TO SAY "Mirrors the real one" AND IT DID NOT. It rebuilt the master chain
    // wholesale — `master.devices = rack.map(...)` — which ADDS devices, while the real
    // applyFxSnapshot dropped every non-resident kind on the floor. So the fake produced the right
    // answer by the wrong method, the coordination tests exercised add/remove against something that
    // could not reproduce the bug, and they passed green while a co-DJ's added reverb never appeared
    // for anyone. A closed-world claim in a FAKE, covering for a closed-world claim in the real code.
    //
    // It now runs the same DECISION the real deck runs (rackDelta), so it cannot be right where the
    // real one is wrong. It still applies that decision the fake way — plain objects, no AudioNodes
    // — which is the part a simulator is allowed to differ on.
    const master = this.chains[this.chains.length - 1];
    const delta = rackDelta(
      master.devices.map((d) => d.kind),
      rack.map((s) => s.kind),
    );
    master.devices = master.devices.filter((d) => !delta.remove.includes(d.kind));
    for (const kind of delta.add) master.devices.push({ kind, params: {}, bypassed: false });
    // Params + bypass by kind, for whatever is now resident — membership first, params second.
    for (const s of rack) {
      const d = master.devices.find((x) => x.kind === s.kind);
      if (!d) continue;
      d.params = { ...(s.params ?? {}) };
      d.bypassed = !!s.bypassed;
    }
    // Order follows the snapshot, residents it omits keeping their relative tail position.
    const wanted = rack.map((s) => s.kind);
    master.devices.sort((a, b) => {
      const ia = wanted.indexOf(a.kind);
      const ib = wanted.indexOf(b.kind);
      return (ia < 0 ? wanted.length : ia) - (ib < 0 ? wanted.length : ib);
    });
    this.log.push(`fxRack ${rack.map((s) => s.kind).join(",")}`);
  }

  // --- everything else -----------------------------------------------------------------------
  private eqSet(k: string, v: number) {
    this.eq[k] = v;
    this.log.push(`${k}=${v}`);
  }
  /** The engine's role hooks, fired at the end of setTempo / setPitch exactly as the real Deck does. */
  onTempoChange?: () => void;
  onPitchChange?: () => void;
  setTempo(v: number) { this.tempo = v; this.log.push(`tempo=${v}`); this.onTempoChange?.(); }
  setTrim(v: number) { this.trim = v; }
  setLevel(v: number) { this.level = v; }
  setEqLow(v: number) { this.eqSet("eqLow", v); }
  setEqMid(v: number) { this.eqSet("eqMid", v); }
  setEqHigh(v: number) { this.eqSet("eqHigh", v); }
  setEqLowFreq(v: number) { this.eqSet("eqLowFreq", v); }
  setEqMidFreq(v: number) { this.eqSet("eqMidFreq", v); }
  setEqHighFreq(v: number) { this.eqSet("eqHighFreq", v); }
  setEqLowQ(v: number) { this.eqSet("eqLowQ", v); }
  setEqMidQ(v: number) { this.eqSet("eqMidQ", v); }
  setEqHighQ(v: number) { this.eqSet("eqHighQ", v); }
  setEqLowShape(v: number) { this.eqSet("eqLowShape", v); }
  setEqMidShape(v: number) { this.eqSet("eqMidShape", v); }
  setEqHighShape(v: number) { this.eqSet("eqHighShape", v); }
  setEqHpFreq(v: number) { this.eqSet("eqHpFreq", v); }
  setEqHpQ(v: number) { this.eqSet("eqHpQ", v); }
  setEqLpFreq(v: number) { this.eqSet("eqLpFreq", v); }
  setEqLpQ(v: number) { this.eqSet("eqLpQ", v); }
  setEqMix(v: number) { this.eqSet("eqMix", v); }
  setEqOut(v: number) { this.eqSet("eqOut", v); }
  setFilter(v: number) { this.filter = v; this.log.push(`filter=${v}`); }
  setPitch(v: number) { this.pitch = v; this.log.push(`pitch=${v}`); this.onPitchChange?.(); }
  setKeylock(v: boolean) { this.toggles.keylock = v; }
  setEqBypass(v: boolean) { this.toggles.eqBypass = v; }
  setQuantize(v: boolean) { this.toggles.quantize = v; }
  setStemGain(stem: StemName, value: number) { this.stemGains[stem] = value; }
  setStemMute(stem: StemName, muted: boolean) { this.stemMutes[stem] = muted; }
  play() { this.playing = true; this.log.push("play"); }
  pause() { this.playing = false; this.log.push("pause"); }
  togglePlay() { if (this.playing) this.pause(); else this.play(); }
  seek(p: number) { this.pos = p; this.log.push(`seek ${p}`); }
  scrubBegin(slip?: boolean) { this.log.push(slip === undefined ? "scrubBegin" : `scrubBegin slip=${slip}`); }
  // Performance gestures that cross as `board` intents (boardActions.ts registers them against the
  // real Deck's methods; these record that they arrived, with what).
  previewHold(pos: number) { this.log.push(`previewHold ${pos}`); }
  previewRelease(slip?: boolean) { this.log.push(`previewRelease slip=${slip}`); }
  bend(d: number) { this.log.push(`bend ${d}`); }
  spinback(strength?: number) { this.log.push(`spinback ${strength ?? "-"}`); }
  releaseBrake() { this.log.push("brake"); }
  setReverse(on: boolean) { this.log.push(`reverse ${on}`); }
  censorBegin() { this.log.push("censorBegin"); }
  censorEnd() { this.log.push("censorEnd"); }
  scrubMove(d: number) { this.log.push(`scrubMove ${d}`); }
  scrubEnd() { this.log.push("scrubEnd"); }
  // The loop surface — the real engine, with a receipt.
  loopIn() { this.log.push("loopIn"); this.loops.loopIn(); }
  loopOut() { this.log.push("loopOut"); this.loops.loopOut(); }
  exitLoop() { this.log.push("exitLoop"); this.loops.exitLoop(); }
  reloop() { this.log.push("reloop"); this.loops.reloop(); }
  setBeatLoop(b: number) { this.log.push(`beatLoop ${b}`); this.loops.setBeatLoop(b); }
  rollOut() { this.log.push("rollOut"); this.loops.rollOut(); }
  clearLoop() { this.log.push("clearLoop"); this.loops.clearLoop(); }
  moveLoop(beats: number) { this.log.push(`moveLoop ${beats}`); this.loops.moveLoop(beats); }
  toggleAdjust(which: "in" | "out") { return this.loops.toggleAdjust(which); }
  adjustStep(units: number) { this.loops.adjustStep(units); }
  setCue() { this.loops.setCue(); }
  hotCue(slot: number) { this.log.push(`hotCue ${slot}`); this.loops.hotCue(slot); }
  saveLoop(slot: number) { this.loops.saveLoop(slot); }
  clearHotCue(slot: number) { this.loops.clearHotCue(slot); }
  slotIsSet(slot: number) { return this.loops.slotIsSet(slot); }
  applyLoopRegion(start: number, end: number, active: boolean) { this.loops.applyLoopRegion(start, end, active); }
  applyLoopState(loop: { start: number; end: number; active: boolean; beats?: number } | null, inPoint?: number | null, seek?: number) { this.loops.applyLoopState(loop, inPoint, seek); }
  applyHotCue(slot: number, cue: number | null, loop: { start: number; end: number; beats?: number } | null) { this.loops.applyHotCue(slot, cue, loop); }
  loopState() { return this.loops.loopState(); }
  // The quantize surface quantizedTransport.ts drives. Deterministic stand-in for Deck.quantized:
  // grid lock on → land on the nearest beat of THIS deck's grid at once (no timer); off → as asked.
  quantizePending = false;
  cancelQuantized() {}
  quantized(target: number, run: (pos: number) => void) {
    run(this.toggles.quantize && this.grid ? nearestBeat(this.grid, target) : target);
  }

  /** The comparable state — what "both devices agree" means, concretely. Chain IDS ARE EXCLUDED
   *  on purpose: they are per-deck sequence numbers and are never expected to match. Names are. */
  snapshot() {
    return {
      chains: this.chains.map((c) => ({
        name: c.name,
        master: c.master,
        stems: c.stems,
        devices: c.devices.map((d) => ({ kind: d.kind, params: d.params, bypassed: d.bypassed })),
      })),
      eq: this.eq,
      toggles: this.toggles,
      stemGains: this.stemGains,
      stemMutes: this.stemMutes,
      tempo: this.tempo,
      trim: this.trim,
      level: this.level,
      filter: this.filter,
      pitch: this.pitch,
      playing: this.playing,
      cuePoint: this.cuePoint,
      skipBeats: this.skipBeats,
      loop: this.loop,
      loopInPoint: this.loopInPoint,
      hotCues: this.hotCues,
      hotLoops: this.hotLoops,
      keylockPinnedOff: this.keylockPinnedOff,
    };
  }
}

/** ★ THE ROLE STATE MACHINE, MODELLED ON AudioEngine's (operator, 2026-11-11: session sync audit).
 *  It used to be two display fields set by `mirror*Display` — the bug itself, faithfully simulated.
 *  Now it holds a real follower id with the engine's semantics: a press on the follower releases, a
 *  press elsewhere engages/flips; the follower tracks its leader's tempo; a tempo/pitch write on the
 *  follower releases unless it is the lock's own echo (the SAME isRoleEcho the engine runs). "Tracks"
 *  is modelled as the follower's tempo becoming the leader's — no beatgrids, no octave folding. */
export class FakeEngine implements IntentEngine {
  readonly decks: Record<DeckId, FakeDeck> = { A: new FakeDeck(), B: new FakeDeck() };
  crossfade = 0;
  commandedRamp = false;
  resumed = 0;
  private slave: DeckId | null = null;
  private keySlaveId: DeckId | null = null;
  private propagating = false;
  /** Fired when roles change with nobody pressing (a release by a tempo move) — AudioEngine.onRolesAuto. */
  onRolesAuto?: (what: "sync" | "key", cause: AutoRoleCause) => void;
  private remoteWrite = false;
  constructor() {
    for (const id of ["A", "B"] as DeckId[]) {
      this.decks[id].onTempoChange = () => this.onDeckTempo(id);
      this.decks[id].onPitchChange = () => this.onDeckPitch(id);
    }
  }
  deck(id: DeckId): FakeDeck {
    return this.decks[id];
  }
  get syncSlave(): DeckId | null {
    return this.slave;
  }
  get keySlave(): DeckId | null {
    return this.keySlaveId;
  }
  setCrossfade(v: number) { this.crossfade = v; }
  setCommandedRamp(on: boolean) { this.commandedRamp = on; }
  syncRole(id: DeckId): "master" | "slave" | "off" {
    return this.slave === id ? "slave" : this.slave ? "master" : "off";
  }
  keyRole(id: DeckId): "master" | "slave" | "off" {
    return this.keySlaveId === id ? "slave" : this.keySlaveId ? "master" : "off";
  }
  private other(id: DeckId): DeckId {
    return id === "A" ? "B" : "A";
  }
  private matchFollower() {
    if (this.slave == null) return;
    this.propagating = true;
    this.decks[this.slave].setTempo(this.decks[this.other(this.slave)].tempo);
    this.propagating = false;
  }
  /** A LOCAL press, as AudioEngine.toggleSync. */
  toggleSync(id: DeckId) {
    if (this.slave === id) this.slave = null;
    else {
      this.slave = id;
      this.matchFollower();
    }
  }
  releaseSync() { this.slave = null; }
  toggleKey(id: DeckId) {
    if (this.keySlaveId === id) {
      this.keySlaveId = null;
      this.propagating = true;
      this.decks[id].setPitch(0);
      this.propagating = false;
    } else {
      this.keySlaveId = id;
      this.propagating = true;
      this.decks[id].setPitch(this.decks[this.other(id)].pitch + 1); // "a compatible key": any deterministic shift
      this.propagating = false;
    }
  }
  private onDeckTempo(id: DeckId) {
    if (this.propagating || this.slave == null) return;
    if (id === this.slave) {
      this.slave = null;
      this.onRolesAuto?.("sync", { kind: "release", remote: this.remoteWrite });
    } else this.matchFollower();
  }
  private onDeckPitch(id: DeckId) {
    if (this.propagating || this.keySlaveId == null) return;
    if (id === this.keySlaveId) {
      this.keySlaveId = null;
      this.onRolesAuto?.("key", { kind: "release", remote: this.remoteWrite });
    }
  }
  resume() { this.resumed++; }
  applySyncRole(slave: DeckId | null) {
    if (slave === this.slave) return;
    this.slave = slave;
    this.matchFollower();
  }
  applyKeyRole(slave: DeckId | null) {
    const prev = this.keySlaveId;
    if (slave === prev) return;
    if (slave == null && prev != null) {
      this.keySlaveId = null;
      this.propagating = true;
      this.decks[prev].setPitch(0);
      this.propagating = false;
    } else if (slave != null) {
      this.keySlaveId = null;
      this.toggleKey(slave);
    }
  }
  applyRemoteTempo(id: DeckId, pct: number, follow?: boolean) {
    const d = this.decks[id];
    if (isRoleEcho({ isFollower: this.slave === id, current: d.tempo, incoming: pct, follow, eps: SYNC_ECHO_TEMPO_EPS })) {
      this.propagating = true;
      d.setTempo(pct);
      this.propagating = false;
    } else {
      this.remoteWrite = true;
      d.setTempo(pct);
      this.remoteWrite = false;
    }
  }
  applyRemotePitch(id: DeckId, semis: number, follow?: boolean) {
    const d = this.decks[id];
    if (isRoleEcho({ isFollower: this.keySlaveId === id, current: d.pitch, incoming: semis, follow, eps: 0 })) {
      this.propagating = true;
      d.setPitch(semis);
      this.propagating = false;
    } else {
      this.remoteWrite = true;
      d.setPitch(semis);
      this.remoteWrite = false;
    }
  }
  takeAlignSeek(): { deck: DeckId; pos: number } | null {
    return null;
  }
  snapshot() {
    return { crossfade: this.crossfade, syncSlave: this.syncSlave, keySlave: this.keySlave, A: this.decks.A.snapshot(), B: this.decks.B.snapshot() };
  }
}

/** One participant: an engine, the host callbacks, and a record of what it sent and received. */
export class SimDevice {
  readonly engine = new FakeEngine();
  readonly sent: Intent[] = [];
  readonly received: Intent[] = [];
  /** Host-side effects an intent triggers that are NOT the engine — recorded, not simulated. */
  readonly hostCalls: string[] = [];
  /** Set by Session so a gesture can go out on the wire. */
  wire: ((intent: Intent, from: SimDevice) => void) | null = null;
  /** The board's authority (Session makes the first device the anchor). */
  anchor = false;
  constructor(readonly name: string) {
    // The App's loopEdit wiring, reproduced: every LOCAL loop mutation broadcasts its absolute
    // result once, and nothing is broadcast while a peer's intent is being applied.
    for (const id of ["A", "B"] as DeckId[]) {
      const deck = this.engine.deck(id);
      deck.onLoopEdit = (edit) => {
        if (isApplyingRemote()) return;
        this.send(loopEditIntent(id, edit, deck.loopState()));
      };
    }
    // Role changes nobody pressed go out by the app's own rule (App.tsx onRolesAuto).
    this.engine.onRolesAuto = (what, cause) => {
      if (!shouldAnnounceAutoRole({ isAnchor: this.anchor, cause })) return;
      const out = what === "sync" ? syncStateIntents(this.engine, null) : keyStateIntents(this.engine);
      for (const i of out) this.emit(i, { local: false });
    };
  }
  /** A SYNC press, exactly as App.pressSync: the engine toggles, then the ordered state crosses. */
  pressSync(id: DeckId): void {
    if (this.engine.syncRole(id) === "master") this.engine.releaseSync();
    else this.engine.toggleSync(id);
    for (const i of syncStateIntents(this.engine, this.engine.takeAlignSeek())) this.emit(i, { local: false });
  }
  /** A KEY press, exactly as App.pressKey. */
  pressKey(id: DeckId): void {
    this.engine.toggleKey(id);
    for (const i of keyStateIntents(this.engine)) this.emit(i, { local: false });
  }
  /** Put an intent on the wire WITHOUT applying it here: the local half already happened (the
   *  gesture ran on this device's deck), which is how a result-carrying emit works in the app. */
  send(intent: Intent): void {
    this.emit(intent, { local: false });
  }

  readonly host: IntentHost = {
    automix: (a) => this.hostCalls.push(`automix:${a}`),
    // ★ THE REAL REGISTRY, against the simulated deck. The cast is the harness's one deliberate
    // lie and it is a narrow one: a BoardApply is typed against Deck but only ever calls deck
    // methods, which FakeDeck has. Recording the call without running it would make every board
    // action pass by definition — which is exactly what an earlier version of this did, and it
    // reported a Smart Fader mode change as delivered when nothing had happened.
    board: (deck, id, phase, arg) => {
      this.hostCalls.push(`board:${deck}:${id}:${phase ?? "-"}:${arg ?? "-"}`);
      applyBoardAction(this.engine.deck(deck) as unknown as BoardDeck, id, phase, arg);
    },
    queue: (q) => this.hostCalls.push(`queue:${q.action}`),
    sample: (s) => this.hostCalls.push(`sample:${s.pad}:${s.action}`),
    crossfade: () => {},
    tempoRange: (v) => this.hostCalls.push(`tempoRange:${v}`),
    load: (deck, videoId) => this.hostCalls.push(`load:${deck}:${videoId}`),
    scrub: (deck, on) => this.hostCalls.push(`scrub:${deck}:${on}`),
    ensureGuestStems: (deck) => this.hostCalls.push(`ensureStems:${deck}`),
    refresh: () => {},
  };

  /** Receive one intent — the REAL apply path. */
  apply(intent: Intent): void {
    this.received.push(intent);
    applyIntent(intent, this.engine, this.host);
  }

  /** Do something locally AND put it on the wire — what every emit site in the app does. The
   *  local half is applied through the same function, which is also how the app works. */
  emit(intent: Intent, { local = true } = {}): void {
    this.sent.push(intent);
    if (local) this.apply(intent);
    this.wire?.(intent, this);
  }
}

/** The room: every device gets every other device's intents, which is what DjRoom.relay does. */
export class Session {
  readonly devices: SimDevice[];
  constructor(...names: string[]) {
    this.devices = names.map((n) => new SimDevice(n));
    if (this.devices[0]) this.devices[0].anchor = true;
    for (const d of this.devices) d.wire = (intent, from) => {
      for (const other of this.devices) if (other !== from) other.apply(intent);
    };
  }
  get host(): SimDevice {
    return this.devices[0];
  }
  get guest(): SimDevice {
    return this.devices[1];
  }
  device(name: string): SimDevice {
    const d = this.devices.find((x) => x.name === name);
    if (!d) throw new Error(`no device ${name}`);
    return d;
  }
  /** Run a setup step on EVERY device — the shared starting point a session begins from (both
   *  devices restored the same snapshot, or built the same rack). */
  each(fn: (d: SimDevice) => void): void {
    for (const d of this.devices) fn(d);
  }
}

/** What the app's FX panels actually do to address a device: find it in the deck's flat list and
 *  send that index. Reproduced here so a test exercises the REAL addressing, bug and all. */
export function slotOf(deck: FakeDeck, chainName: string, kind: string): number {
  const d = deck.deviceAt(chainName, kind);
  return d ? deck.allDevices.indexOf(d) : -1;
}
