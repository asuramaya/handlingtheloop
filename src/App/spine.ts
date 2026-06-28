// The ambient SPINE — the handful of values threaded into every hook/component. Lives in its own
// module so hooks/components import it WITHOUT cycling through App.tsx. App creates these once at
// the top and provides them; everything else PULLS via useSpine()/useEngine() instead of receiving
// them as props or deps-bag entries. A new concern becomes a new file that reads context, never an
// App.tsx edit to thread one more prop. `engine` is a lazy singleton; `emit` is built deep inside
// AppBody (it needs the room), so descendants reach it through `emitRef`, a stable ref filled there.
import { createContext, useContext } from "react";
import type { MutableRefObject } from "react";
import type { AudioEngine } from "@htl";
import type { Intent } from "@htl/room";

export interface Spine {
  engine: AudioEngine;
  refresh: () => void;
  emitRef: MutableRefObject<(intent: Intent) => void>;
}

export const SpineContext = createContext<Spine | null>(null);

export function useSpine(): Spine {
  const s = useContext(SpineContext);
  if (!s) throw new Error("useSpine must be used within <App>");
  return s;
}

export function useEngine(): AudioEngine {
  return useSpine().engine;
}
