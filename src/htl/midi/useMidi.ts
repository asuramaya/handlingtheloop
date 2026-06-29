// React glue for the MIDI engine. Owns one MidiEngine for the app's lifetime,
// surfaces its connection status, drives MIDI-Learn, and exposes a feedback hook
// so the UI can light the controller. The actual control routing (events → deck
// setters / action handlers) lives in App, passed in as `onEvent`, so the engine
// stays decoupled from the audio graph.

import { useCallback, useEffect, useRef, useState } from "react";
import { learnControl } from "./controls";
import { MidiEngine, type MonMsg, type OutMsg, type MidiCapture } from "./MidiEngine";
import type { DeckId, DeckFeedback, MidiEvent, MidiLearnMap, MidiStatus } from "./types";

export interface UseMidiArgs {
  enabled: boolean;
  learn: MidiLearnMap; // settings.midiBindings
  onEvent: (e: MidiEvent) => void;
  onLearnChange: (next: MidiLearnMap) => void; // persist to settings
}

export interface UseMidi {
  supported: boolean;
  status: MidiStatus;
  connect: () => void; // request access (user gesture)
  learningId: string | null; // control id currently being learned (or null)
  armLearn: (controlId: string | null) => void;
  clearLearn: (controlId: string) => void;
  setFeedback: (deck: DeckId, fb: DeckFeedback) => void;
  info: () => { error: string; permMidi: string; permSysex: string; crossOriginIsolated: boolean | string };
  monitor: () => MonMsg[];
  describe: (status: number, d1: number) => string | null;
  jogCadence: () => { rate: number; count: number; medMs: number; p95Ms: number; maxGapMs: number; burst: number; avgTick: number };
  // Output side — for the debug panel's LED / RGB feedback prober.
  send: (bytes: number[]) => void; // raw MIDI out (notes, CC, SysEx)
  outMonitor: () => OutMsg[]; // recent outgoing messages
  outputs: () => string[]; // names of connected output ports
  // Golden capture — record raw incoming bytes for the byte-replay tests.
  startCapture: () => void;
  stopCapture: () => MidiCapture | null;
}

export function useMidi({ enabled, learn, onEvent, onLearnChange }: UseMidiArgs): UseMidi {
  const [status, setStatus] = useState<MidiStatus>({ state: "idle" });
  const [learningId, setLearningId] = useState<string | null>(null);

  // Latest values via refs so the single long-lived engine always sees fresh data.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const learnRef = useRef(learn);
  learnRef.current = learn;
  const onLearnChangeRef = useRef(onLearnChange);
  onLearnChangeRef.current = onLearnChange;
  const learningIdRef = useRef<string | null>(null);

  const engineRef = useRef<MidiEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new MidiEngine({
      onEvent: (e) => onEventRef.current(e),
      onStatus: setStatus,
      getLearn: () => learnRef.current,
      onLearnCapture: (cap) => {
        const id = learningIdRef.current;
        learningIdRef.current = null;
        setLearningId(null);
        if (!id) return;
        const lc = learnControl(id);
        if (!lc) return;
        const next: MidiLearnMap = {
          ...learnRef.current,
          [id]: { status: cap.status, data: cap.data, type: cap.type, control: lc.control, deck: lc.deck },
        };
        onLearnChangeRef.current(next);
        engineRef.current?.refreshLearn();
      },
    });
  }

  const supported = engineRef.current!.supported();

  // Reconnect on load ONLY if the permission is already granted (silent, no prompt).
  // When it isn't, we wait for an explicit user click (the toggle / Connect button) so
  // Chrome shows the prompt with the user activation it requires. Tear down when off.
  useEffect(() => {
    const eng = engineRef.current!;
    if (!enabled || !supported) {
      eng.stop();
      return;
    }
    let cancelled = false;
    void eng.permissionGranted().then((granted) => {
      if (!cancelled && granted) void eng.start();
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, supported]);

  // Push learn-map edits (e.g. a cleared binding) into the live index.
  useEffect(() => {
    engineRef.current?.refreshLearn();
  }, [learn]);

  const connect = useCallback(() => void engineRef.current?.start(), []);

  const armLearn = useCallback((controlId: string | null) => {
    learningIdRef.current = controlId;
    setLearningId(controlId);
    engineRef.current?.armLearn(!!controlId);
  }, []);

  const clearLearn = useCallback((controlId: string) => {
    const next = { ...learnRef.current };
    delete next[controlId];
    onLearnChangeRef.current(next);
    engineRef.current?.refreshLearn();
  }, []);

  const setFeedback = useCallback((deck: DeckId, fb: DeckFeedback) => engineRef.current?.setFeedback(deck, fb), []);
  const info = useCallback(() => engineRef.current!.info(), []);
  const monitor = useCallback(() => engineRef.current!.monitor(), []);
  const describe = useCallback((status: number, d1: number) => engineRef.current!.describe(status, d1), []);
  const jogCadence = useCallback(() => engineRef.current?.jogCadence() ?? { rate: 0, count: 0, medMs: 0, p95Ms: 0, maxGapMs: 0, burst: 0, avgTick: 0 }, []);
  const send = useCallback((bytes: number[]) => engineRef.current?.sendRaw(bytes), []);
  const outMonitor = useCallback(() => engineRef.current?.outMonitor() ?? [], []);
  const outputs = useCallback(() => engineRef.current?.outputNames() ?? [], []);
  const startCapture = useCallback(() => engineRef.current?.startCapture(), []);
  const stopCapture = useCallback(() => engineRef.current?.stopCapture() ?? null, []);

  return { supported, status, connect, learningId, armLearn, clearLearn, setFeedback, info, monitor, describe, jogCadence, send, outMonitor, outputs, startCapture, stopCapture };
}
