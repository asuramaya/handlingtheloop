// Settings ▸ Debug — the flight recorder, live engine/session/device diagnostics, the MIDI
// prober, the separation crash trace, and one-click bug reports. Owns its own polling state;
// it mounts only while the Debug tab is open, so the poll runs exactly while visible.
//
// ★ Written in the shared settings grammar (see the block comment atop settings.css) and made
// to actually DEBUG. Three things it could not do before:
//   • SEE THE FLIGHT RECORDER. The event ring has existed for ages, recorded faithfully, and
//     was readable only by SENDING a bug report and asking someone at the other end to look.
//     On a phone — which is the whole reason this tab exists, since there is no console there —
//     the most useful thing in the app was the least reachable. It is on screen now.
//   • HOLD STILL. Live diagnostics repaint 2.5 times a second, which is exactly wrong for
//     reading a number: the value you are squinting at is gone before you finish. Freeze stops
//     the clock without unmounting anything.
//   • BE SEARCHED. Six blocks of key/value rows and a 300-event ring, with no way to ask "where
//     does the word `sync` appear". One filter box now narrows both.
import { useEffect, useMemo, useState } from "react";
import { readStemTrace, clearStemTrace, formatStemTrace } from "@htl";
import { submitBugReport } from "@htl/debug/report";
import { dumpRing, clearRing, formatEvent } from "@htl/debug/trace";
import type { UseMidi } from "@htl/midi";
import type { DebugSection } from "../../App";
import { MidiDebug } from "../MidiDebug";
import { InfoDot } from "./InfoDot";

export function DebugTab({ midi, debug }: { midi?: UseMidi; debug?: () => DebugSection[] }) {
  const [diag, setDiag] = useState<DebugSection[]>([]);
  const [copied, setCopied] = useState<string | null>(null); // which block (or "all") just copied
  const [traceTick, setTraceTick] = useState(0); // bump to re-read the separation trace
  const [frozen, setFrozen] = useState(false);
  const [filter, setFilter] = useState("");
  const [events, setEvents] = useState<Array<Record<string, unknown>>>([]);
  const [reportDesc, setReportDesc] = useState("");
  const [reporting, setReporting] = useState(false);
  const [reportMsg, setReportMsg] = useState<string | null>(null);
  const [storage, setStorage] = useState<string | null>(null);

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

  // ONE poll drives both the diagnostics and the recorder, and `frozen` stops it at the source
  // rather than at the render — a paused view fed by a running interval still burns the battery
  // it was paused to save, and still races whatever you are reading.
  useEffect(() => {
    if (frozen) return;
    const tick = () => {
      if (debug) setDiag(debug());
      setEvents(dumpRing());
    };
    tick();
    const iv = setInterval(tick, 400);
    return () => clearInterval(iv);
  }, [debug, frozen]);

  // How much disk the caches actually hold. This app writes stem sets, packed int16 and album
  // art to OPFS/IndexedDB, and "the browser evicted your stems" looks exactly like "stems are
  // broken" from the inside. One line here separates the two.
  useEffect(() => {
    let dead = false;
    void navigator.storage?.estimate?.().then(
      (e) => {
        if (dead) return;
        const mb = (n?: number) => (n == null ? "?" : `${(n / 1048576).toFixed(0)} MB`);
        const pct = e.usage != null && e.quota ? ` · ${((e.usage / e.quota) * 100).toFixed(1)}%` : "";
        setStorage(`${mb(e.usage)} of ${mb(e.quota)}${pct}`);
      },
      () => {},
    );
    return () => {
      dead = true;
    };
  }, [frozen]);

  const q = filter.trim().toLowerCase();
  const shownDiag = useMemo(() => {
    if (!q) return diag;
    return diag
      .map((s) => ({ ...s, rows: s.rows.filter(([k, v]) => `${k} ${v}`.toLowerCase().includes(q)) }))
      .filter((s) => s.rows.length || s.title.toLowerCase().includes(q));
  }, [diag, q]);
  const shownEvents = useMemo(() => {
    const lines = events.map(formatEvent);
    return q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
  }, [events, q]);

  return (
    <>
      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Report a problem</span>
          <InfoDot
            text="Describe what went wrong in a line and send. It bundles the build version, your device, the live engine state, the recent-event ring and any crash trace, so nobody has to ask you to open a console — which on a phone you could not do anyway."
            label="Report a problem"
          />
        </div>
        <textarea
          className="debug-report-input"
          rows={2}
          placeholder="What went wrong? (e.g. “cue is delayed and pitched”)"
          value={reportDesc}
          maxLength={2000}
          onChange={(e) => setReportDesc(e.target.value)}
        />
        <div className="settings-row">
          <span className="settings-label">Send</span>
          <span className="settings-control">
            {reportMsg && <span className="settings-value">{reportMsg}</span>}
            <button className="hw-btn small" disabled={reporting} onClick={() => void sendReport()}>
              {reporting ? "Sending…" : "Send report"}
            </button>
          </span>
        </div>
      </div>

      {/* The two controls that make everything below readable, so they sit above everything
          below rather than being repeated per block. */}
      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Inspector</span>
          <InfoDot
            text="Freeze stops the 400 ms poll so a value holds still long enough to read, and stops the work as well as the repaint. Filter narrows both the diagnostics and the event log to lines containing what you type, so you can follow one subsystem through a reproduction instead of reading everything."
            label="Inspector"
          />
        </div>
        <div className="settings-row">
          <span className="settings-label">Live updates</span>
          <span className="settings-control">
            <span className="settings-value">{frozen ? "frozen" : "400 ms"}</span>
            <button
              className={`toggle ${frozen ? "" : "on"}`}
              onClick={() => setFrozen((v) => !v)}
              role="switch"
              aria-checked={!frozen}
              aria-label="Live updates"
            >
              <span className="toggle-knob" />
            </button>
          </span>
        </div>
        <div className="settings-row">
          <span className="settings-label">Filter</span>
          <span className="settings-control">
            <input
              className="debug-filter"
              value={filter}
              placeholder="sync, stem, ctx…"
              aria-label="Filter diagnostics and events"
              onChange={(e) => setFilter(e.target.value)}
            />
          </span>
        </div>
        {storage && (
          <div className="settings-row">
            <span className="settings-label">
              Cache storage
              <InfoDot
                text="How much disk the browser has given this origin and how much the caches are using. Stem sets, packed audio and album art all live here. A browser that has evicted your cached stems looks identical to broken stems from the inside; this is what tells the two apart."
                label="Cache storage"
              />
            </span>
            <span className="settings-control">
              <span className="settings-value">{storage}</span>
            </span>
          </div>
        )}
      </div>

      {/* ★ THE FLIGHT RECORDER, ON SCREEN. */}
      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Event log</span>
          <InfoDot
            text="The last 300 significant things the app did, oldest first, stamped from page load: track loads, transitions, sync toggles, uncaught errors, and every warning the app logged about itself. This is the how-did-we-get-here that a bug report carries, and it is the same data — reading it here is usually faster than sending it. Clear it, reproduce the bug, and read only what it did."
            label="Event log"
          />
          <button className="link-btn" onClick={() => copy(events.map(formatEvent).join("\n"), "events")}>
            {copied === "events" ? "Copied ✓" : "Copy"}
          </button>
          <button
            className="link-btn"
            onClick={() => {
              clearRing();
              setEvents([]);
            }}
          >
            Clear
          </button>
        </div>
        {shownEvents.length ? (
          <pre className="debug-log">{shownEvents.join("\n")}</pre>
        ) : (
          <p className="settings-note">{q ? `No events match “${filter}”.` : "Nothing recorded yet."}</p>
        )}
      </div>

      {/* MIDI capture (in) + feedback prober (out) — always on, for building maps
          and reverse-engineering LED / RGB protocols. */}
      {midi && <MidiDebug midi={midi} />}

      {diag.length > 0 && (
        <div className="settings-section">
          <div className="settings-section-head">
            <span className="settings-label">Live diagnostics</span>
            <InfoDot
              text="The engine, session and device state as it is right now, polled while this tab is open. Copy dumps it as text, which is the only practical way to read state off a phone."
              label="Live diagnostics"
            />
            <button className="link-btn" onClick={() => copy(diag.map(sectionText).join("\n\n"), "all")}>
              {copied === "all" ? "Copied ✓" : "Copy all"}
            </button>
          </div>
          {shownDiag.length === 0 ? (
            <p className="settings-note">No diagnostics match “{filter}”.</p>
          ) : (
            <div className="debug-grid">
              {shownDiag.map((s) => (
                <div className="debug-block" key={s.title}>
                  <div className="debug-block-title">
                    <span>{s.title}</span>
                    {/* Per-section copy — grab just this block instead of the whole dump. */}
                    <button className="link-btn" onClick={() => copy(sectionText(s), s.title)}>
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
          )}
        </div>
      )}

      {/* On-device separation crash trace — survives a tab OOM-kill (synchronous
          localStorage), so after a crash + reload this shows the LAST step it
          reached. The only way to debug an iPhone Safari crash without a Mac. */}
      {(() => {
        const trace = readStemTrace();
        return (
          <div className="settings-section">
            <div className="settings-section-head">
              <span className="settings-label">Separation trace</span>
              <InfoDot
                text="Written synchronously to local storage, so it survives the tab being killed for running out of memory. After a crash and a reload, the last line is where it stopped — and that step is the culprit. It is the only way to debug an iPhone Safari crash without a Mac attached."
                label="Separation trace"
              />
              {trace.length > 0 && (
                <button
                  className="link-btn"
                  onClick={() => {
                    clearStemTrace();
                    setTraceTick((n) => n + 1);
                  }}
                >
                  Clear
                </button>
              )}
            </div>
            {trace.length ? (
              <pre className="stem-trace" key={traceTick}>
                {formatStemTrace(trace)}
              </pre>
            ) : (
              <p className="settings-note">Nothing recorded. Run a stem split and it appears here.</p>
            )}
          </div>
        );
      })()}
    </>
  );
}
