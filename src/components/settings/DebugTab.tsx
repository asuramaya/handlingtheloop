// Settings ▸ Debug — MIDI prober + live engine/session/device diagnostics + the
// on-device separation crash trace. Owns its own polling state; it mounts only while
// the Debug tab is open, so the poll runs exactly while visible (idle otherwise).
import { useEffect, useState } from "react";
import { readStemTrace, clearStemTrace, formatStemTrace } from "@htl";
import { submitBugReport } from "@htl/debug/report";
import type { UseMidi } from "@htl/midi";
import type { DebugSection } from "../../App";
import { MidiDebug } from "../MidiDebug";
import { RackLab } from "../RackLab";

export function DebugTab({ midi, debug }: { midi?: UseMidi; debug?: () => DebugSection[] }) {
  // Live diagnostics — poll the collector (engine/session/device) a few times a second
  // while this tab is mounted. `copied` flashes the Copy button (sharing the dump is the
  // only practical way to debug a phone).
  const [diag, setDiag] = useState<DebugSection[]>([]);
  const [copied, setCopied] = useState<string | null>(null); // which block (or "all") just copied
  const [traceTick, setTraceTick] = useState(0); // bump to re-read the separation trace
  // One-click bug report: pack the build version + device + live snapshot + event ring + crash trace.
  const [reportDesc, setReportDesc] = useState("");
  const [reporting, setReporting] = useState(false);
  const [reportMsg, setReportMsg] = useState<string | null>(null);
  const sendReport = async () => {
    setReporting(true);
    setReportMsg(null);
    const st = readStemTrace();
    const r = await submitBugReport({
      description: reportDesc,
      sections: debug ? debug() : [],
      stemTrace: st.length ? formatStemTrace(st) : null,
    });
    setReporting(false);
    setReportMsg(r.ok ? `Sent ✓ ${(r.id ?? "").slice(0, 8)}` : `Failed — ${r.error ?? "unknown"}`);
    if (r.ok) setReportDesc("");
  };
  const sectionText = (s: DebugSection) => `[${s.title}]\n` + s.rows.map(([k, v]) => `  ${k}: ${v}`).join("\n");
  const copy = (text: string, id: string) =>
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(id);
        setTimeout(() => setCopied((c) => (c === id ? null : c)), 1200);
      },
      () => {},
    );
  useEffect(() => {
    if (!debug) return;
    const tick = () => setDiag(debug());
    tick();
    const iv = setInterval(tick, 400);
    return () => clearInterval(iv);
  }, [debug]);

  return (
    <>
      {/* RACKLAB — the stem-routed FX layout prototype. Unwired on purpose: it answers whether the
          design reads before any of the routing gets built. Lives in Debug because it is a
          question, not a feature; it leaves with the answer. */}
      <div className="settings-section">
        <div className="settings-section-head">
          <h3>Rack lab</h3>
          <p>Layout prototype for stem-routed FX — no audio, nothing wired.</p>
        </div>
        <RackLab />
      </div>

      {/* One-click bug report — the whole flight recorder in a sentence + a button. Packs the build
          SHA, device, live engine/session snapshot, the recent-event ring and any crash trace into a
          single bounded report so it can actually be diagnosed. */}
      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Report a problem</span>
        </div>
        <p className="settings-hint">
          Something off? Describe it in a line and send. It bundles the build version, your device, the
          live engine state, recent events and any crash trace — no console needed.
        </p>
        <textarea
          rows={2}
          style={{
            width: "100%",
            resize: "vertical",
            boxSizing: "border-box",
            background: "var(--panel-2, var(--panel))",
            color: "var(--text)",
            border: "1px solid var(--line)",
            borderRadius: 6,
            padding: "8px 10px",
            font: "inherit",
            fontSize: 14,
            lineHeight: 1.4,
            outlineColor: "var(--accent)",
          }}
          placeholder="What went wrong? (e.g. “cue is delayed and pitched”)"
          value={reportDesc}
          maxLength={2000}
          onChange={(e) => setReportDesc(e.target.value)}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
          <button className="btn" disabled={reporting} onClick={() => void sendReport()}>
            {reporting ? "Sending…" : "Send report"}
          </button>
          {reportMsg && <span className="settings-hint">{reportMsg}</span>}
        </div>
      </div>

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
            <button className="link-btn" onClick={() => copy(diag.map(sectionText).join("\n\n"), "all")}>
              {copied === "all" ? "Copied ✓" : "Copy all"}
            </button>
          </div>
          <div className="debug-grid">
            {diag.map((s) => (
              <div className="debug-block" key={s.title}>
                <div className="debug-block-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span>{s.title}</span>
                  {/* Per-section copy — grab just this block instead of the whole dump. */}
                  <button className="link-btn" style={{ fontSize: "0.8em" }} onClick={() => copy(sectionText(s), s.title)}>
                    {copied === s.title ? "✓" : "copy"}
                  </button>
                </div>
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
