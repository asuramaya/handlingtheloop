// Settings ▸ Debug ▸ Performance capture, and the floating chip that stops it.
//
// The recording has to run while the operator PLAYS, i.e. with Settings closed, so the recorder is
// module-level (perfCapture.ts) and this panel only arms it. The chip is mounted by App for as long
// as a recording runs: it shows the clock and ends the recording in one tap, wherever you are.
import { useEffect, useState } from "react";
import {
  downloadPerfCapture,
  perfCaptureSeconds,
  perfCapturing,
  perfMark,
  startPerfCapture,
  stopPerfCapture,
  summarizePerf,
} from "@htl/debug/perfCapture";
import { InfoDot } from "./settings/InfoDot";

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

function usePerfState(): { on: boolean; secs: number } {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    listeners.add(f);
    const id = setInterval(() => perfCapturing() && f(), 1000);
    return () => {
      listeners.delete(f);
      clearInterval(id);
    };
  }, []);
  return { on: perfCapturing(), secs: perfCaptureSeconds() };
}

let lastSummary: string | null = null;
function finish() {
  const c = stopPerfCapture();
  if (c) {
    lastSummary = summarizePerf(c);
    downloadPerfCapture(c);
  }
  notify();
}

export function PerfCaptureSection() {
  const { on, secs } = usePerfState();
  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <span className="settings-label">Performance capture</span>
        <InfoDot
          label="Performance capture"
          text="Records dropped frames, what held the main thread during each long frame, how long clicks/keys/pads took to show, memory, and audio dropouts. Start it, close Settings, play and scratch the way that feels laggy, then stop it from the red REC chip. A JSON file downloads; nothing is sent anywhere."
        />
      </div>
      <div className="settings-row">
        {on ? (
          <>
            <button className="link-btn" onClick={finish}>
              Stop + download ({Math.round(secs)} s)
            </button>
            <button className="link-btn" onClick={() => perfMark("mark")}>
              Mark this moment
            </button>
          </>
        ) : (
          <button
            className="link-btn"
            onClick={() => {
              startPerfCapture();
              lastSummary = null;
              notify();
            }}
          >
            Record performance
          </button>
        )}
      </div>
      {!on && lastSummary && <p className="settings-note">Last capture: {lastSummary}</p>}
    </div>
  );
}

/** Floating REC chip while a capture runs. Tap to stop + download. */
export function PerfRecChip() {
  const { on, secs } = usePerfState();
  if (!on) return null;
  return (
    <button className="perf-rec-chip" onClick={finish} title="Stop the performance capture and download it">
      ● REC perf {Math.round(secs)} s · stop
    </button>
  );
}
