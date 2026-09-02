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
import type { Deck } from "../audio/Deck";
import { applyIntent, type IntentDeck, type IntentEngine, type IntentHost } from "./applyIntent";

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
  position = 0;
  cuePoint = 0;
  skipBeats = 4;
  loop: { start: number; end: number; active: boolean } | null = null;
  beatLoop = 0;
  hotCues: (number | null)[] = Array(8).fill(null);
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
    // Mirrors the real one: it rebuilds the MASTER chain and says nothing about stem chains.
    const master = this.chains[this.chains.length - 1];
    master.devices = rack.map((s) => ({ kind: s.kind, params: { ...(s.params ?? {}) }, bypassed: !!s.bypassed }));
    this.log.push(`fxRack ${rack.map((s) => s.kind).join(",")}`);
  }

  // --- everything else -----------------------------------------------------------------------
  private eqSet(k: string, v: number) {
    this.eq[k] = v;
    this.log.push(`${k}=${v}`);
  }
  setTempo(v: number) { this.tempo = v; this.log.push(`tempo=${v}`); }
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
  setPitch(v: number) { this.pitch = v; this.log.push(`pitch=${v}`); }
  setKeylock(v: boolean) { this.toggles.keylock = v; }
  setEqBypass(v: boolean) { this.toggles.eqBypass = v; }
  setQuantize(v: boolean) { this.toggles.quantize = v; }
  setStemGain(stem: StemName, value: number) { this.stemGains[stem] = value; }
  setStemMute(stem: StemName, muted: boolean) { this.stemMutes[stem] = muted; }
  play() { this.playing = true; this.log.push("play"); }
  pause() { this.playing = false; this.log.push("pause"); }
  seek(p: number) { this.position = p; this.log.push(`seek ${p}`); }
  scrubBegin() { this.log.push("scrubBegin"); }
  scrubMove(d: number) { this.log.push(`scrubMove ${d}`); }
  scrubEnd() { this.log.push("scrubEnd"); }
  loopIn() { this.log.push("loopIn"); }
  loopOut() { this.log.push("loopOut"); }
  exitLoop() { this.loop = null; this.log.push("exitLoop"); }
  reloop() { this.log.push("reloop"); }
  setBeatLoop(b: number) { this.beatLoop = b; this.log.push(`beatLoop ${b}`); }
  hotCue(slot: number) { this.log.push(`hotCue ${slot}`); }
  saveLoop(slot: number) { this.hotCues[slot] = this.position; }
  clearHotCue(slot: number) { this.hotCues[slot] = null; }
  applyLoopRegion(start: number, end: number, active: boolean) { this.loop = { start, end, active }; }

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
      beatLoop: this.beatLoop,
      hotCues: this.hotCues,
      keylockPinnedOff: this.keylockPinnedOff,
    };
  }
}

export class FakeEngine implements IntentEngine {
  readonly decks: Record<DeckId, FakeDeck> = { A: new FakeDeck(), B: new FakeDeck() };
  crossfade = 0;
  commandedRamp = false;
  syncSlave: DeckId | null = null;
  keySlave: DeckId | null = null;
  resumed = 0;
  deck(id: DeckId): FakeDeck {
    return this.decks[id];
  }
  setCrossfade(v: number) { this.crossfade = v; }
  setCommandedRamp(on: boolean) { this.commandedRamp = on; }
  // SmartFader beat-locks the incoming deck through these; the simulator only needs them to exist
  // and to be consistent — no beat-matching is simulated and none is claimed.
  private slave: DeckId | null = null;
  syncRole(id: DeckId): "master" | "slave" | null {
    return this.slave === id ? "slave" : this.slave ? "master" : null;
  }
  toggleSync(id: DeckId) { this.slave = this.slave === id ? null : id; }
  resume() { this.resumed++; }
  mirrorSyncDisplay(slave: DeckId | null) { this.syncSlave = slave; }
  mirrorKeyDisplay(slave: DeckId | null) { this.keySlave = slave; }
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
  constructor(readonly name: string) {}

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
