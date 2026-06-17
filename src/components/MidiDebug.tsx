// MIDI debug surface (Settings ▸ Debug). An always-on view of the wire in both
// directions — input for building maps, output for verifying LED feedback:
//   • IN  — the live monitor: raw bytes + what each currently maps to.
//   • OUT — connected ports, a raw-byte send to poke a lamp, and a log of everything
//           the app sends (manual pokes AND the LED-feedback diffs it emits live).
// Needs only the UseMidi hook; no audio-graph coupling.

import { useEffect, useState } from "react";
import type { UseMidi, MonMsg, OutMsg } from "@htl/midi";

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");

function kind(status: number, d2: number): string {
  const hi = status & 0xf0;
  if (hi === 0x90) return d2 > 0 ? "note on" : "note off";
  if (hi === 0x80) return "note off";
  if (hi === 0xb0) return "cc";
  if (status === 0xf0) return "sysex";
  return "";
}

// Parse a loose hex string ("90 24 7F", "0x90,0x24", "F0 … F7") → bytes, or null.
function parseBytes(s: string): number[] | null {
  const toks = s.trim().split(/[\s,]+/).filter(Boolean);
  if (!toks.length) return null;
  const out: number[] = [];
  for (const t of toks) {
    const n = parseInt(t.replace(/^0x/i, ""), 16);
    if (Number.isNaN(n) || n < 0 || n > 255) return null;
    out.push(n);
  }
  return out;
}

export function MidiDebug({ midi }: { midi: UseMidi }) {
  const [inMon, setInMon] = useState<MonMsg[]>([]);
  const [outMon, setOutMon] = useState<OutMsg[]>([]);
  const [jog, setJog] = useState(() => midi.jogCadence());
  const [raw, setRaw] = useState("");
  // Both rings are filled by the engine continuously — just mirror them on a timer.
  useEffect(() => {
    const iv = setInterval(() => {
      setInMon(midi.monitor());
      setOutMon(midi.outMonitor());
      setJog(midi.jogCadence());
    }, 120);
    return () => clearInterval(iv);
  }, [midi]);

  const outs = midi.outputs();
  const sendRaw = () => {
    const b = parseBytes(raw);
    if (b) midi.send(b);
  };

  return (
    <>
      {/* JOG CADENCE — instrumentation for the scratch velocity model. Spin the platter
          and read: a steady mouse is ~1–8 ms/tick with ~0 burst; a bursty/sparse hardware
          jog shows a high burst% (sub-1ms clusters) + big max-gap — the case the alpha-beta
          filter smooths. */}
      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Jog scratch cadence</span>
          <span className="settings-hint" style={{ margin: 0 }}>
            scratch the jog to measure
          </span>
        </div>
        <div className="midi-monitor-row" style={{ flexWrap: "wrap", gap: "10px 16px" }}>
          <span className="midi-monitor-meta">{jog.rate.toFixed(0)} ticks/s</span>
          <span className="midi-monitor-meta">med {jog.medMs.toFixed(1)} ms</span>
          <span className="midi-monitor-meta">p95 {jog.p95Ms.toFixed(1)} ms</span>
          <span className="midi-monitor-meta">maxgap {jog.maxGapMs.toFixed(0)} ms</span>
          <span className="midi-monitor-meta" style={{ color: jog.burst > 0.25 ? "var(--accent, #e66)" : undefined }}>
            burst {(jog.burst * 100).toFixed(0)}%
          </span>
          <span className="midi-monitor-meta">avg |tick| {jog.avgTick.toFixed(1)}</span>
          <span className="midi-monitor-meta">n {jog.count}</span>
        </div>
      </div>

      {/* INPUT — the live monitor (the map-building surface) */}
      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">MIDI input</span>
          <span className="settings-hint" style={{ margin: 0 }}>
            press a control to read its bytes
          </span>
        </div>
        <div className="midi-monitor">
          {inMon.length === 0 ? (
            <div className="midi-monitor-empty">waiting for input… (enable MIDI + connect a controller)</div>
          ) : (
            inMon
              .slice()
              .reverse()
              .map((m) => (
                <div key={m.seq} className="midi-monitor-row">
                  <span className="midi-monitor-bytes">
                    {hex2(m.status)} {hex2(m.d1)} {hex2(m.d2)}
                  </span>
                  <span className="midi-monitor-map">{midi.describe(m.status, m.d1) ?? "—"}</span>
                  <span className="midi-monitor-meta">{kind(m.status, m.d2)}</span>
                </div>
              ))
          )}
        </div>
      </div>

      {/* OUTPUT — connected ports, a raw poke, and the send log */}
      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">MIDI output</span>
          <span className="settings-hint" style={{ margin: 0 }}>
            {outs.length ? `→ ${outs.join(", ")}` : "no output port"}
          </span>
        </div>
        <div className="midi-dbg-row">
          <input
            className="midi-dbg-hex"
            value={raw}
            spellCheck={false}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendRaw()}
            placeholder="send hex — e.g. 90 24 7F"
            aria-label="Raw MIDI bytes to send (hex)"
          />
          <button className="link-btn" onClick={sendRaw} disabled={!parseBytes(raw)}>
            Send
          </button>
        </div>
        <div className="midi-monitor midi-dbg-out">
          {outMon.length === 0 ? (
            <div className="midi-monitor-empty">nothing sent yet</div>
          ) : (
            outMon
              .slice()
              .reverse()
              .map((m) => (
                <div key={m.seq} className="midi-monitor-row">
                  <span className="midi-monitor-bytes">{m.bytes.map(hex2).join(" ")}</span>
                  <span className="midi-monitor-meta">{kind(m.bytes[0], m.bytes[2] ?? 0)}</span>
                </div>
              ))
          )}
        </div>
      </div>
    </>
  );
}
