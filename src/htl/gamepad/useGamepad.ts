import { useEffect, useRef, useState } from "react";
import type { AudioEngine, DeckId } from "@htl/audio";
import type { MidiEvent } from "@htl/midi";
import { GamepadEngine, type GamepadStatus } from "./GamepadEngine";

// Mount a GamepadEngine for the app's lifetime. The callbacks are kept in refs so the polling
// loop always sees the latest focus + onEvent without tearing the engine down each render.
export function useGamepad(opts: {
  engine: AudioEngine;
  getFocused: () => DeckId;
  onEvent: (e: MidiEvent) => void;
  getLibraryOpen?: () => boolean; // pad reads this live → crate-dig mode when the library is open
  enabled?: boolean;
}): GamepadStatus {
  const [status, setStatus] = useState<GamepadStatus>({ connected: false, id: null });
  const focusRef = useRef(opts.getFocused);
  focusRef.current = opts.getFocused;
  const eventRef = useRef(opts.onEvent);
  eventRef.current = opts.onEvent;
  const libOpenRef = useRef(opts.getLibraryOpen);
  libOpenRef.current = opts.getLibraryOpen;
  const enabledRef = useRef(opts.enabled ?? true);
  enabledRef.current = opts.enabled ?? true;
  const { engine } = opts;

  useEffect(() => {
    const gp = new GamepadEngine({
      engine,
      getFocused: () => focusRef.current(),
      onEvent: (e) => eventRef.current(e),
      getLibraryOpen: () => libOpenRef.current?.() ?? false,
      getEnabled: () => enabledRef.current,
      onStatus: setStatus,
    });
    gp.start();
    return () => gp.stop();
  }, [engine]);

  return status;
}
