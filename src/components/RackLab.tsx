import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// RACKLAB — UNWIRED layout prototypes for stem-routed FX. No audio, no rack, no routing.
//
// ★ THE CORRECTION THAT MATTERS (operator, on seeing candidate C beside the real deck):
//   master/detail is right, "but there isn't enough room." True — and the reason is that the lab
//   was measuring the wrong box. The host is not a page; it is a DECK COLUMN, ~430 px wide, and
//   there are TWO of them side by side. A 148 px rail eats a third of that.
//
//   The room already exists, and it is HORIZONTAL. `.fx-tabs` is a chip row that scrolls instead
//   of squishing (fx.css:45) with the device panel beneath it — the shipped strip is ALREADY
//   master/detail. So nothing new gets invented: the chains ride in the same kind of row, or they
//   are folded into the chips that are already there.
//
//   D1 · CHAIN TABS — one extra 22 px row above the device tabs. Selecting a chain repopulates
//        the device row beneath it. Costs one row of height and ZERO width, and it is the only
//        candidate that can express two devices of the SAME KIND on different stems — which
//        matters because the rack is FIXED-MEMBERSHIP (FxStrip.tsx:170): one REVERB exists, so
//        without chains "vox reverb + drum reverb at once" is unsayable.
//
//   D2 · PER-DEVICE TARGET — zero new rows. The stem target is a property of the device chip: a
//        2 px coloured underline on the chip, and the four sends live in the device panel's own
//        header, revealed the way this app already reveals detail (right-click / long-press, as
//        the I/O strip folds DEST/SRC into MIC/REC). Cheapest possible surface. The cost is the
//        fixed bank: one device, one target, so you cannot have two differently-aimed reverbs.
//
//   C · RAIL — candidate C kept for contrast, at deck-column width, so the "not enough room"
//        verdict stays visible next to the two that fit.

const LANES = [
  { id: "drums", label: "DRUM", color: "#ff5d73" },
  { id: "bass", label: "BASS", color: "#b06bff" },
  { id: "vocals", label: "VOICE", color: "#5dff9e" },
  { id: "other", label: "INST", color: "#36c2ff" },
] as const;
type LaneId = (typeof LANES)[number]["id"];
type Sends = Record<LaneId, number>;
const ALL: Sends = { drums: 1, bass: 1, vocals: 1, other: 1 };
const NONE: Sends = { drums: 0, bass: 0, vocals: 0, other: 0 };

// "ALL" / "DRUM" / "VOICE +1" — the summary that replaces four coloured panels in the common
// cases, which are nearly all the cases.
function describe(s: Sends): { text: string; colors: string[] } {
  const on = LANES.filter((l) => s[l.id] > 0);
  if (!on.length) return { text: "—", colors: [] };
  if (on.length === LANES.length && LANES.every((l) => s[l.id] === 1)) return { text: "ALL", colors: LANES.map((l) => l.color) };
  const head = on[0];
  const rest = on.length - 1;
  return { text: rest ? `${head.label} +${rest}` : head.label, colors: on.map((l) => l.color) };
}

interface Chain {
  id: string;
  name: string;
  sends: Sends;
  devices: string[];
  gen?: boolean;
}
const CHAINS: Chain[] = [
  { id: "mix", name: "MIX", sends: { ...ALL }, devices: ["EQ", "SAT", "REVERB", "DELAY", "CRUSH", "GATE", "MOD", "COMP"] },
  { id: "a", name: "DRUM", sends: { ...NONE, drums: 1 }, devices: ["GATE", "CRUSH", "COMP"] },
  { id: "b", name: "VOX", sends: { ...NONE, vocals: 1, other: 0.4 }, devices: ["REVERB", "DELAY", "SAT"] },
  { id: "c", name: "RISER", sends: { ...NONE }, devices: ["NOISE"], gen: true },
];

// The shipped bank, fixed membership — EQ plus the seven permanent residents.
const BANK: { kind: string; stem: LaneId | null }[] = [
  { kind: "EQ", stem: null },
  { kind: "SAT", stem: null },
  { kind: "REVERB", stem: "vocals" },
  { kind: "DELAY", stem: "vocals" },
  { kind: "CRUSH", stem: null },
  { kind: "GATE", stem: "drums" },
  { kind: "MOD", stem: null },
  { kind: "COMP", stem: null },
  { kind: "NOISE", stem: null },
];

// DECK-COLUMN widths, not page widths. The screenshot's two decks sit at ~450 px each; a phone
// gives one deck the whole screen; a 4 K widescreen gives each deck room it does not need.
const WIDTHS = [
  { w: 320, label: "phone deck" },
  { w: 375, label: "iPhone" },
  { w: 450, label: "★ desktop" },
  { w: 560, label: "wide deck" },
  { w: 720, label: "4K deck" },
  { w: 0, label: "fill" },
];

export function RackLab() {
  const [view, setView] = useState<"d1" | "d2" | "c">("d1");
  const [width, setWidth] = useState(450);
  const [full, setFull] = useState(false);
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
  // `zoom`, not `transform: scale` — zoom scales LAYOUT, so the prototype still measures its
  // simulated width and its own breakpoints fire. A transform scales pixels and leaves the
  // original layout box behind.
  const zoom = width && avail && width > avail ? avail / width : 1;

  const body = (
    <div className={`rl ${full ? "rl-full" : ""}`}>
      <div className="rl-head">
        <div className="rl-views">
          <button className={view === "d1" ? "active" : ""} onClick={() => setView("d1")}>
            D1 · chain tabs
          </button>
          <button className={view === "d2" ? "active" : ""} onClick={() => setView("d2")}>
            D2 · per-device
          </button>
          <button className={view === "c" ? "active" : ""} onClick={() => setView("c")}>
            C · rail
          </button>
        </div>
        <div className="rl-widths">
          <button className={full ? "active" : ""} onClick={() => setFull((f) => !f)} title="Full screen">
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
      {zoom < 1 && <div className="rl-zoom">shown at {Math.round(zoom * 100)}%</div>}
      <div className="rl-stage" ref={stage}>
        <div className="rl-frame" style={width ? { width, zoom } : undefined}>
          {view === "d1" ? <ChainTabsView /> : view === "d2" ? <PerDeviceView /> : <RailView />}
        </div>
      </div>
      <p className="rl-note">
        {view === "d1" ? (
          <>
            <b>D1 · chain tabs.</b> One extra 22&nbsp;px row above the device tabs, in the same chip language that already
            scrolls instead of squishing. Zero width cost. The only candidate that can say <b>two reverbs on different
            stems</b> — which the fixed-membership bank otherwise makes unsayable.
          </>
        ) : view === "d2" ? (
          <>
            <b>D2 · per-device.</b> No new surface at all: the stem target is a 2&nbsp;px underline on the chip you already
            tap, and the sends live in the device panel's header behind the app's existing right-click reveal. Cheapest thing
            that could work — but one device, one target, so differently-aimed copies of the same effect are impossible.
          </>
        ) : (
          <>
            <b>C · rail,</b> at deck-column width — kept only to show the verdict. A 148&nbsp;px rail takes a third of a
            450&nbsp;px deck, and there are two decks. The room in this layout is horizontal and it is already spent.
          </>
        )}
      </p>
    </div>
  );
  // Portalled when expanded: the settings panel animates with a TRANSFORM, and a transformed
  // ancestor becomes the containing block for position:fixed — so "full screen" was otherwise
  // full-settings-panel, the one width it exists to escape.
  return full ? createPortal(body, document.body) : body;
}

// A stand-in for the shipped device panel: the dome/curve area, its foot, nothing real.
function PanelBody({ name, head }: { name: string; head?: React.ReactNode }) {
  return (
    <div className="rl-panel">
      {head}
      <div className="rl-panel-art">
        <span>{name}</span>
      </div>
      <div className="rl-panel-foot">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}

function Sends({ sends, onLane }: { sends: Sends; onLane: (l: LaneId) => void }) {
  return (
    <div className="rl-sends">
      {LANES.map((l) => {
        const v = sends[l.id];
        return (
          <button key={l.id} className={`rl-send ${v ? "on" : ""}`} style={{ ["--lane" as string]: l.color }} onClick={() => onLane(l.id)}>
            <span className="rl-send-lab">{l.label}</span>
            <span className="rl-send-bar">
              <i style={{ width: `${Math.round(v * 100)}%` }} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

const bump = (v: number) => (v === 0 ? 0.4 : v < 1 ? 1 : 0);

// ---- D1 · CHAIN TABS -------------------------------------------------------------------------
function ChainTabsView() {
  const [chains, setChains] = useState(CHAINS);
  const [sel, setSel] = useState("a");
  const [dev, setDev] = useState(0);
  const [sendsOpen, setSendsOpen] = useState(false);
  const chain = chains.find((c) => c.id === sel) ?? chains[0];
  const d = describe(chain.sends);
  const device = chain.devices[Math.min(dev, chain.devices.length - 1)];

  return (
    <div className="rl-strip">
      {/* MASTER — chains, in the same chip row language. 22px. */}
      <div className="rl-row rl-row-chain">
        {chains.map((c) => {
          const cd = describe(c.sends);
          return (
            <button
              key={c.id}
              className={`rl-chip chain ${sel === c.id ? "sel" : ""}`}
              style={{ ["--edge" as string]: c.gen ? "#ffb03a" : cd.colors[0] ?? "var(--line)" }}
              onClick={() => {
                setSel(c.id);
                setDev(0);
                setSendsOpen(false);
              }}
            >
              {c.name}
            </button>
          );
        })}
        <button className="rl-chip add">+</button>
      </div>
      {/* DETAIL, level 1 — the shipped device row, for this chain. */}
      <div className="rl-row">
        {chain.devices.map((k, i) => (
          <button key={`${k}${i}`} className={`rl-chip ${i === Math.min(dev, chain.devices.length - 1) ? "sel" : ""}`} onClick={() => setDev(i)}>
            {k}
          </button>
        ))}
      </div>
      {/* DETAIL, level 2 — the device panel, unchanged from what ships. */}
      <PanelBody
        name={device}
        head={
          <div className="rl-panel-head">
            <span className="rl-chain-tag" style={{ ["--edge" as string]: chain.gen ? "#ffb03a" : d.colors[0] ?? "var(--line)" }}>
              {chain.name}
            </span>
            {chain.gen ? (
              <span className="rl-src gen">GEN</span>
            ) : (
              <button className={`rl-src ${sendsOpen ? "open" : ""}`} onClick={() => setSendsOpen((v) => !v)}>
                <span className="rl-src-dots">
                  {d.colors.map((col, i) => (
                    <i key={i} style={{ background: col }} />
                  ))}
                </span>
                {d.text}
              </button>
            )}
          </div>
        }
      />
      {sendsOpen && !chain.gen && (
        <Sends
          sends={chain.sends}
          onLane={(l) => setChains((prev) => prev.map((c) => (c.id !== chain.id ? c : { ...c, sends: { ...c.sends, [l]: bump(c.sends[l]) } })))}
        />
      )}
    </div>
  );
}

// ---- D2 · PER-DEVICE TARGET ------------------------------------------------------------------
function PerDeviceView() {
  const [bank, setBank] = useState(BANK);
  const [sel, setSel] = useState(2);
  const [open, setOpen] = useState(false);
  const cur = bank[sel];
  const lane = cur.stem ? LANES.find((l) => l.id === cur.stem)! : null;
  const sends: Sends = { ...NONE, ...(cur.stem ? { [cur.stem]: 1 } : ALL) } as Sends;

  return (
    <div className="rl-strip">
      {/* ONE row — exactly what ships, plus a 2px underline where a device is aimed. */}
      <div className="rl-row">
        {bank.map((b, i) => {
          const l = b.stem ? LANES.find((x) => x.id === b.stem)! : null;
          return (
            <button
              key={b.kind}
              className={`rl-chip ${sel === i ? "sel" : ""} ${l ? "aimed" : ""}`}
              style={l ? ({ ["--edge" as string]: l.color } as React.CSSProperties) : undefined}
              onClick={() => {
                setSel(i);
                setOpen(false);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setSel(i);
                setOpen(true);
              }}
            >
              {b.kind}
            </button>
          );
        })}
      </div>
      <PanelBody
        name={cur.kind}
        head={
          <div className="rl-panel-head">
            <button className={`rl-src ${open ? "open" : ""}`} style={lane ? ({ ["--edge" as string]: lane.color } as React.CSSProperties) : undefined} onClick={() => setOpen((v) => !v)}>
              {lane && (
                <span className="rl-src-dots">
                  <i style={{ background: lane.color }} />
                </span>
              )}
              {lane ? lane.label : "ALL STEMS"}
            </button>
            <span className="rl-hint">right-click a chip to aim it</span>
          </div>
        }
      />
      {open && (
        <Sends
          sends={sends}
          onLane={(l) => setBank((prev) => prev.map((b, i) => (i !== sel ? b : { ...b, stem: b.stem === l ? null : l })))}
        />
      )}
    </div>
  );
}

// ---- C · RAIL (kept for contrast, at deck-column width) --------------------------------------
function RailView() {
  const [sel, setSel] = useState("a");
  const chain = CHAINS.find((c) => c.id === sel) ?? CHAINS[0];
  return (
    <div className="rl-strip">
      <div className="rl-md-body">
        <div className="rl-rail">
          <div className="rl-rail-head">
            <span>CHAINS</span>
          </div>
          {CHAINS.map((c) => {
            const cd = describe(c.sends);
            return (
              <button
                key={c.id}
                className={`rl-railrow ${sel === c.id ? "sel" : ""}`}
                style={{ ["--edge" as string]: c.gen ? "#ffb03a" : cd.colors[0] ?? "var(--line)" }}
                onClick={() => setSel(c.id)}
              >
                <span className="rl-railrow-name">{c.name}</span>
                <span className="rl-railrow-src">{c.gen ? "GEN" : cd.text}</span>
              </button>
            );
          })}
        </div>
        <div className="rl-rail-detail">
          <div className="rl-row">
            {chain.devices.map((k, i) => (
              <button key={`${k}${i}`} className={`rl-chip ${i === 0 ? "sel" : ""}`}>
                {k}
              </button>
            ))}
          </div>
          <PanelBody name={chain.devices[0]} />
        </div>
      </div>
    </div>
  );
}
