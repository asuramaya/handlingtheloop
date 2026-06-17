// Settings ▸ Debug — MIDI prober + live engine/session/device diagnostics + the
// on-device separation crash trace. Owns its own polling state; it mounts only while
// the Debug tab is open, so the poll runs exactly while visible (idle otherwise).
import { useEffect, useState } from "react";
import { readStemTrace, clearStemTrace, formatStemTrace } from "@htl";
import type { UseMidi } from "@htl/midi";
import type { DebugSection } from "../../App";
import { MidiDebug } from "../MidiDebug";

export function DebugTab({ midi, debug }: { midi?: UseMidi; debug?: () => DebugSection[] }) {
  // Live diagnostics — poll the collector (engine/session/device) a few times a second
  // while this tab is mounted. `copied` flashes the Copy button (sharing the dump is the
  // only practical way to debug a phone).
  const [diag, setDiag] = useState<DebugSection[]>([]);
  const [copied, setCopied] = useState(false);
  const [traceTick, setTraceTick] = useState(0); // bump to re-read the separation trace
  useEffect(() => {
    if (!debug) return;
    const tick = () => setDiag(debug());
    tick();
    const iv = setInterval(tick, 400);
    return () => clearInterval(iv);
  }, [debug]);

  return (
    <>
      {/* MIDI capture (in) + feedback prober (out) — always on, for building maps
          and reverse-engineering LED / RGB protocols. Open-source debug surface. */}
      {midi && <MidiDebug midi={midi} />}

      {/* Live engine / session / device diagnostics (was the green ctx overlay).
          Polled only while this tab is open; Copy dumps it for sharing — the
          only practical way to read state off a phone (no visible console). */}
      {diag.length > 0 && (
        <div className="settings-section">
          <div className="settings-section-head">
            <span className="settings-label">Live diagnostics</span>
            <button
              className="link-btn"
              onClick={() => {
                const text = diag
                  .map((s) => `[${s.title}]\n` + s.rows.map(([k, v]) => `  ${k}: ${v}`).join("\n"))
                  .join("\n\n");
                void navigator.clipboard?.writeText(text).then(
                  () => { setCopied(true); setTimeout(() => setCopied(false), 1200); },
                  () => {},
                );
              }}
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
          <div className="debug-grid">
            {diag.map((s) => (
              <div className="debug-block" key={s.title}>
                <div className="debug-block-title">{s.title}</div>
                {s.rows.map(([k, v]) => (
                  <div className="debug-row" key={k}>
                    <span className="debug-key">{k}</span>
                    <span className="debug-val">{v}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* On-device separation crash trace — survives a tab OOM-kill (synchronous
          localStorage), so after a crash + reload this shows the LAST step it
          reached. The only way to debug an iPhone Safari crash without a Mac. */}
      {(() => {
        const trace = readStemTrace();
        if (!trace.length) {
          return (
            <div className="settings-section">
              <p className="settings-hint">No separation trace yet. Run a stem split and it'll be recorded here.</p>
            </div>
          );
        }
        return (
          <div className="settings-section">
            <div className="settings-section-head">
              <span className="settings-label">Separation trace (diagnostics)</span>
              <button
                className="link-btn"
                onClick={() => {
                  clearStemTrace();
                  setTraceTick((n) => n + 1);
                }}
              >
                Clear
              </button>
            </div>
            <pre className="stem-trace" key={traceTick}>
              {formatStemTrace(trace)}
            </pre>
            <div className="settings-hint">
              Last line = where it stopped. If it ends mid-run after a crash, that step is the culprit.
            </div>
          </div>
        );
      })()}
    </>
  );
}
