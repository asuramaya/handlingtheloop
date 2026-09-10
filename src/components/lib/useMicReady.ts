import { useEffect, useState } from "react";
import type { AudioEngine } from "@htl/audio";

/** Is the live mic actually running?
 *
 *  `MicInput.on` is a plain getter with no change event, and the FX panels' `useRefresh` is a
 *  manual callback rather than a subscription — so reading it at render alone would go stale the
 *  moment someone toggles the mic with a panel already open, and stay stale indefinitely. That is
 *  the failure worth avoiding: a control that says the mic is off while you are talking into it is
 *  worse than one that never claimed to know.
 *
 *  A slow poll is the honest fit. Mic on/off is a human gesture, so a beat of lag is invisible,
 *  and at 500 ms this costs nothing next to the rAF the viz beside it already runs. Polling only
 *  while mounted keeps it to the panels actually on screen. */
export function useMicReady(engine: AudioEngine | null | undefined, intervalMs = 500): boolean {
  const [ready, setReady] = useState(() => !!engine?.mic.on);
  useEffect(() => {
    if (!engine) {
      setReady(false);
      return;
    }
    const read = () => setReady(!!engine.mic.on);
    read(); // don't wait a full interval to be correct on mount
    const t = setInterval(read, intervalMs);
    return () => clearInterval(t);
  }, [engine, intervalMs]);
  return ready;
}
