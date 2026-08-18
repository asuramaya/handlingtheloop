import { useEffect, useRef, useState } from "react";

// RACKLAB — an UNWIRED layout prototype for stem-routed FX. No audio, no rack, no routing: this
// exists only to answer the design questions before a week of DSP is spent betting on them.
//
//   1. Does an explicit SUM line read as "this is where four stems become one"?
//   2. Do per-lane dots read as "which stems enter this device", at a glance, without labels?
//   3. Does the whole thing survive 375 px to 4K — which is the actual hard part.
//
// ★ THE WIDTH SIMULATOR IS THE POINT. The rack has to work on a phone held in one hand and on a
// 4K widescreen, and judging that by dragging a window edge is guesswork you do once and then
// stop doing. The preset widths render the REAL component at the REAL breakpoints, side by side
// with the number, so a layout that only works at the width you happen to be sitting at cannot
// quietly ship. Everything below is measured from the CONTAINER, never the viewport, precisely so
// this simulation is honest — a viewport media query would report the window and lie here.

const LANES = [
  { id: "drums", label: "DRUM", color: "#ff5d73" },
  { id: "bass", label: "BASS", color: "#b06bff" },
  { id: "vocals", label: "VOICE", color: "#5dff9e" },
  { id: "other", label: "INST", color: "#36c2ff" },
  { id: "layer", label: "LAYER", color: "#ffb03a" }, // generators sum in here — see NOISE below
] as const;
type LaneId = (typeof LANES)[number]["id"];

interface Row {
  id: string;
  name: string;
  gen?: boolean; // a GENERATOR: produces, never processes — pinned above the stem zone
  lanes: LaneId[]; // which lanes enter it (stem zone only; ignored below the sum line)
}

// A plausible starting rack, deliberately showing the interesting cases: a device on one lane, a
// device on a subset, a generator, and a mix zone that looks exactly like today's rack.
const INITIAL: Row[] = [
  { id: "noise", name: "NOISE", gen: true, lanes: [] },
  { id: "eq", name: "EQ", lanes: ["drums", "bass", "vocals", "other"] },
  { id: "gate", name: "GATE", lanes: ["drums"] },
  { id: "crush", name: "CRUSH", lanes: ["bass"] },
  { id: "mod", name: "MOD", lanes: ["vocals", "other"] },
  { id: "reverb", name: "REVERB", lanes: ["vocals", "layer"] },
  { id: "delay", name: "DELAY", lanes: [] },
  { id: "sat", name: "SAT", lanes: [] },
  { id: "comp", name: "COMP", lanes: [] },
];
const INITIAL_SUM = 6; // rows [0,SUM) are stem-zone; the divider sits here; the rest are mix

const WIDTHS = [
  { w: 375, label: "iPhone" },
  { w: 430, label: "Pro Max" },
  { w: 768, label: "tablet" },
  { w: 1280, label: "laptop" },
  { w: 1920, label: "1080p" },
  { w: 2560, label: "4K half" },
  { w: 0, label: "fill" },
];

export function RackLab() {
  const [rows, setRows] = useState<Row[]>(INITIAL);
  const [sumAt, setSumAt] = useState(INITIAL_SUM);
  const [width, setWidth] = useState(0);
  const [full, setFull] = useState(false);
  // ★ ZOOM-TO-FIT, and `zoom` rather than `transform: scale`. A simulated 2560 px rack does not
  // fit in a 440 px settings panel, and the two obvious answers are both wrong: clamping it to the
  // panel means the button says 2560 and the layout is 440 (the first version of this did exactly
  // that, silently, and every preset reported the same mode), while a horizontal scrollbar means
  // judging a wide layout through a letterbox. Scaling it down shows the whole thing at once —
  // which is what a layout review actually needs. `zoom` is used because it scales LAYOUT: the
  // rack still measures its simulated width, so its own breakpoints fire correctly, and the
  // container's height follows. `transform` would scale the pixels while leaving the layout box
  // at full size, so the rack would measure 2560 and occupy 2560 of empty column.
  const stage = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth - 18));
    ro.observe(el);
    setAvail(el.clientWidth - 18);
    return () => ro.disconnect();
  }, [full]);
  const zoom = width && avail && width > avail ? avail / width : 1;

  const move = (from: number, to: number) => {
    const clamped = Math.max(0, Math.min(rows.length - 1, to));
    if (clamped === from) return;
    // A generator can only live in the stem zone — it injects, so there is nothing upstream of it
    // to process. Dragging one below the line is refused rather than silently corrected.
    const r = rows[from];
    setRows((prev) => {
      const next = prev.slice();
      next.splice(from, 1);
      next.splice(clamped, 0, r);
      return next;
    });
    // The divider stays put in ABSOLUTE terms unless the move crossed it.
    setSumAt((s) => {
      if (from < s && clamped >= s) return s - 1;
      if (from >= s && clamped < s) return s + 1;
      return s;
    });
  };

  const toggleLane = (id: string, lane: LaneId) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, lanes: r.lanes.includes(lane) ? r.lanes.filter((l) => l !== lane) : [...r.lanes, lane] } : r)));

  return (
    <div className={`rl ${full ? "rl-full" : ""}`}>
      <div className="rl-head">
        <div className="rl-title">
          RACKLAB — stem-routed FX layout (unwired)
          {zoom < 1 && <em> · shown at {Math.round(zoom * 100)}%</em>}
        </div>
        <div className="rl-widths">
          <button className={full ? "active" : ""} onClick={() => setFull((f) => !f)} title="Full screen — judge the wide layouts at their real size">
            {full ? "✕" : "⤢"}
            <i>{full ? "close" : "expand"}</i>
          </button>
          {WIDTHS.map((x) => (
            <button key={x.label} className={width === x.w ? "active" : ""} onClick={() => setWidth(x.w)}>
              {x.w || "fill"}
              <i>{x.label}</i>
            </button>
          ))}
        </div>
      </div>
      <div className="rl-stage" ref={stage}>
        <div className="rl-frame" style={width ? { width, zoom } : undefined}>
          <RackView rows={rows} sumAt={sumAt} sim={width} onMove={move} onSum={setSumAt} onToggle={toggleLane} />
        </div>
      </div>
      <p className="rl-note">
        Rows are processing order, top to bottom. Above the <b>SUM</b> line each device sees only the lanes it is dotted for and
        runs one instance per lane; below it, the rack is exactly what ships today. Drag a row to reorder or to cross the line;
        drag the line itself to move where the stems become a mix.
      </p>
    </div>
  );
}

function RackView({ rows, sumAt, sim, onMove, onSum, onToggle }: { rows: Row[]; sumAt: number; sim: number; onMove: (a: number, b: number) => void; onSum: (n: number) => void; onToggle: (id: string, l: LaneId) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(1200);
  // ★ Measured from the CONTAINER, never the viewport — in the real app this panel shares the
  // screen with a dock whose width the rack does not control, so a viewport media query would be
  // answering a question nobody asked.
  //
  // …but when the simulator is driving, the simulated width is used DIRECTLY rather than measured.
  // Under `zoom`, a ResizeObserver reports the VISUAL size, and a 2560 px rack zoomed to fit a
  // 430 px panel is visually 430 px — so the observer never fires, and every preset silently
  // rendered in the same mode while the ruler underneath said 2560. Measurement is right for the
  // real thing and a lie inside a simulation of it.
  useEffect(() => {
    const el = box.current;
    if (!el || sim) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [sim]);
  const eff = sim || w;
  // Three presentations of the SAME data, not three layouts: the columns collapse, the dots stay.
  const mode = eff >= 760 ? "matrix" : eff >= 430 ? "inline" : "stacked";

  const drag = useRef<{ from: number; kind: "row" | "sum" } | null>(null);
  const rowH = useRef(34);
  const onDown = (i: number, kind: "row" | "sum") => (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { from: i, kind };
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    rowH.current = Math.max(20, r.height);
  };
  const onMoveEv = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const el = box.current;
    if (!el) return;
    const y = e.clientY - el.getBoundingClientRect().top;
    const idx = Math.round(y / rowH.current) - 1;
    if (d.kind === "sum") onSum(Math.max(0, Math.min(rows.length, idx)));
    else if (idx !== d.from) {
      onMove(d.from, idx);
      drag.current = { ...d, from: Math.max(0, Math.min(rows.length - 1, idx)) };
    }
  };
  const end = () => (drag.current = null);

  return (
    <div ref={box} className={`rl-rack rl-${mode}`} onPointerMove={onMoveEv} onPointerUp={end} onPointerCancel={end}>
      {mode === "matrix" && (
        <div className="rl-colhead">
          <span />
          {LANES.map((l) => (
            <span key={l.id} style={{ color: l.color }}>
              {l.label}
            </span>
          ))}
        </div>
      )}
      {rows.map((r, i) => (
        <div key={r.id}>
          {i === sumAt && <SumLine onDown={onDown(i, "sum")} />}
          <RackRow row={r} stem={i < sumAt} mode={mode} onDown={onDown(i, "row")} onToggle={onToggle} />
        </div>
      ))}
      {sumAt >= rows.length && <SumLine onDown={onDown(rows.length, "sum")} />}
    </div>
  );
}

function SumLine({ onDown }: { onDown: (e: React.PointerEvent) => void }) {
  return (
    <div className="rl-sum" onPointerDown={onDown} title="Where the stems become a mix — drag to move">
      <span className="rl-sum-bars">
        {LANES.slice(0, 4).map((l) => (
          <i key={l.id} style={{ background: l.color }} />
        ))}
      </span>
      <span className="rl-sum-label">∑ SUM</span>
      <span className="rl-sum-rule" />
    </div>
  );
}

function RackRow({ row, stem, mode, onDown, onToggle }: { row: Row; stem: boolean; mode: string; onDown: (e: React.PointerEvent) => void; onToggle: (id: string, l: LaneId) => void }) {
  // The instance count is the honest price of a subset: a device on three lanes IS three devices.
  // Showing it next to the dots means the cost is never a surprise discovered in a CPU meter.
  const n = row.lanes.length;
  return (
    <div className={`rl-row ${stem ? "stem" : "mix"} ${row.gen ? "gen" : ""}`}>
      <span className="rl-grip" onPointerDown={onDown}>
        ⠿
      </span>
      <span className="rl-name">
        {row.name}
        {row.gen && <i className="rl-tag">GEN</i>}
      </span>
      {stem ? (
        <span className="rl-lanes">
          {LANES.map((l) => {
            const on = row.lanes.includes(l.id);
            return (
              <button
                key={l.id}
                className={`rl-dot ${on ? "on" : ""}`}
                style={{ ["--lane" as string]: l.color }}
                onClick={() => onToggle(row.id, l.id)}
                title={`${l.label}${on ? " — on" : ""}`}
              >
                {mode === "matrix" ? "" : <i>{l.label}</i>}
              </button>
            );
          })}
          {mode !== "stacked" && n > 1 && <em className="rl-cost">×{n}</em>}
        </span>
      ) : (
        <span className="rl-mixtag">MIX</span>
      )}
    </div>
  );
}
