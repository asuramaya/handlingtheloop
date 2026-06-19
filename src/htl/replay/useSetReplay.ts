// G1c — recorded-set replay. A "set" is a persisted broadcast recipe (commands only; see
// G1a). Replay feeds that recipe log back through the SAME engine handlers a LIVE broadcast
// listener uses (applyRoomSnapshot / onRoomIntent / onRoomTick / setRemoteAutomix in App),
// but driven by a LOCAL clock instead of the WebSocket → a deterministic on-device rebuild of
// the mix. No audio is stored; the device re-resolves each track's source + re-renders. D5's
// engineVersion pins fidelity (a mismatch warns). The host's downsampled ~1/sec ticks are the
// playhead anchors; the intent stream carries transport/cue/loop/fx; the decks play their own
// audio at 1x and the ticks correct drift — exactly the live-listener contract.
import { useCallback, useEffect, useRef, useState } from "react";
import { type ClientMsg, ENGINE_VERSION } from "@htl/room";

export interface RecordedEntry {
  t: number; // ms from set start
  m: ClientMsg; // a recipe message (state / intent / tick / automix)
}
export interface RecordedLog {
  engineVersion: number;
  duration: number; // ms
  log: RecordedEntry[];
}

// What the replay needs from App: route a recipe message through the live-listener handlers,
// and a hard "stop the audio" for pause/seek/stop (the decks play their own clock once a
// transport intent starts them, so the driver must be able to halt them directly).
export interface ReplayControl {
  dispatch: (m: ClientMsg) => void;
  pauseAudio: () => void;
}

export interface ReplayState {
  setId: string | null; // the set being replayed (null = idle)
  active: boolean; // a set is loaded (playing or paused)
  loading: boolean;
  playing: boolean;
  position: number; // ms
  duration: number; // ms
  engineStale: boolean; // recipe's engineVersion ≠ ours → the rebuild may differ (D5)
  play: (setId: string) => void; // load + start from the top
  toggle: () => void; // play/pause
  seek: (ms: number) => void;
  stop: () => void; // tear down, release the decks
}

const POS_THROTTLE_MS = 200; // how often the progress UI updates (the clock itself is rAF-precise)

export function useSetReplay(control: ReplayControl): ReplayState {
  const [setId, setSetId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [engineStale, setEngineStale] = useState(false);

  const ctl = useRef(control);
  ctl.current = control;
  const logRef = useRef<RecordedEntry[]>([]);
  const durRef = useRef(0);
  const idxRef = useRef(0); // next entry to fire
  const baseRef = useRef(0); // performance.now() corresponding to position 0
  const posRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastUiRef = useRef(0);

  const stopClock = () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };

  // The rAF heartbeat: fire every entry whose timestamp has arrived, advance the playhead.
  const loop = useCallback(() => {
    const elapsed = performance.now() - baseRef.current;
    const log = logRef.current;
    while (idxRef.current < log.length && log[idxRef.current].t <= elapsed) {
      try {
        ctl.current.dispatch(log[idxRef.current].m);
      } catch {
        /* a single bad entry never kills the set */
      }
      idxRef.current++;
    }
    posRef.current = Math.min(elapsed, durRef.current);
    const now = performance.now();
    if (now - lastUiRef.current > POS_THROTTLE_MS) {
      lastUiRef.current = now;
      setPosition(posRef.current);
    }
    if (idxRef.current >= log.length && elapsed >= durRef.current) {
      stopClock();
      ctl.current.pauseAudio();
      posRef.current = durRef.current;
      setPosition(durRef.current);
      setPlaying(false); // reached the end (stays "active" so the bar shows the finished set)
      return;
    }
    rafRef.current = requestAnimationFrame(loop);
  }, []);

  const startClock = useCallback(() => {
    baseRef.current = performance.now() - posRef.current;
    stopClock();
    rafRef.current = requestAnimationFrame(loop);
  }, [loop]);

  // The most recent tick at/just-before a position — re-firing it re-asserts the decks'
  // play/pause + playhead (used to resume audio after a pause without a full rebuild).
  const reassert = (target: number) => {
    const log = logRef.current;
    for (let i = Math.min(idxRef.current, log.length) - 1; i >= 0; i--) {
      if (log[i].t <= target && log[i].m.t === "tick") {
        ctl.current.dispatch(log[i].m);
        return;
      }
    }
  };

  // Rebuild deck state at an arbitrary position (seek): apply the last snapshot ≤ target as a
  // baseline, then every intent/automix up to target in order, then the final tick to set the
  // playhead + transport. Skipping intermediate ticks avoids a storm of corrective seeks.
  const rebuildAt = (target: number) => {
    const log = logRef.current;
    ctl.current.pauseAudio();
    let lastState = -1;
    let end = 0;
    for (; end < log.length && log[end].t <= target; end++) {
      if (log[end].m.t === "state") lastState = end;
    }
    if (lastState >= 0) ctl.current.dispatch(log[lastState].m);
    let lastTick = -1;
    for (let j = lastState + 1; j < end; j++) {
      const k = log[j].m.t;
      if (k === "tick") lastTick = j;
      else if (k !== "state") ctl.current.dispatch(log[j].m); // intents + automix in order
    }
    if (lastTick >= 0) ctl.current.dispatch(log[lastTick].m);
    idxRef.current = end;
    posRef.current = target;
    setPosition(target);
  };

  const play = useCallback(
    (id: string) => {
      stopClock();
      ctl.current.pauseAudio();
      setSetId(id);
      setLoading(true);
      setPlaying(false);
      setPosition(0);
      posRef.current = 0;
      idxRef.current = 0;
      logRef.current = [];
      fetch(`/api/sets/${encodeURIComponent(id)}?log=1`, { credentials: "same-origin" })
        .then((r) => (r.ok ? (r.json() as Promise<RecordedLog>) : null))
        .then((data) => {
          if (!data) {
            setLoading(false);
            setSetId(null);
            return;
          }
          logRef.current = data.log ?? [];
          durRef.current = Math.max(0, data.duration || (logRef.current.at(-1)?.t ?? 0));
          setDuration(durRef.current);
          setEngineStale(data.engineVersion !== ENGINE_VERSION);
          setLoading(false);
          setPlaying(true);
          startClock();
        })
        .catch(() => {
          setLoading(false);
          setSetId(null);
        });
    },
    [startClock],
  );

  const toggle = useCallback(() => {
    if (!setId) return;
    if (playing) {
      stopClock();
      ctl.current.pauseAudio();
      setPlaying(false);
    } else {
      if (posRef.current >= durRef.current) {
        // resume from the end → restart
        rebuildAt(0);
      } else {
        reassert(posRef.current); // re-issue the last tick → decks resume playing
      }
      setPlaying(true);
      startClock();
    }
  }, [setId, playing, startClock]);

  const seek = useCallback(
    (ms: number) => {
      if (!setId) return;
      const target = Math.max(0, Math.min(durRef.current, ms));
      stopClock();
      rebuildAt(target);
      if (playing) startClock();
    },
    [setId, playing, startClock],
  );

  const stop = useCallback(() => {
    stopClock();
    ctl.current.pauseAudio();
    setSetId(null);
    setPlaying(false);
    setPosition(0);
    posRef.current = 0;
    idxRef.current = 0;
    logRef.current = [];
  }, []);

  // Clean up the rAF on unmount.
  useEffect(() => () => stopClock(), []);

  return { setId, active: setId !== null, loading, playing, position, duration, engineStale, play, toggle, seek, stop };
}
