import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// RACKLAB — UNWIRED layout prototypes for stem-routed FX. No audio, no rack, no routing.
//
// Two candidates, switchable, because the first two attempts both failed the same way and the
// failure is worth stating: BOTH made the plumbing the loudest thing on screen. A stem×device grid
// of dots, then a wall of sixteen saturated send blocks — different drawings of the same mistake,
// which is treating ROUTING STATE as the content. It is not the content. The devices are.
//
// The references, none of which routes per device:
//   • Ableton — parallel CHAINS in a rack; the chain list shows a NAME, routing lives behind
//     selection. • FL Studio — channels → mixer inserts; routing is a mixer concern with send
//     knobs. • Traktor Stem Decks — each stem carries VOLUME, FILTER and FX SEND: the control is
//     an AMOUNT on the stem, small, at the edge. • djay Pro AI — stem-specific effects are
//     assigned to PADS: the stem is part of the EFFECT'S IDENTITY, not a routing decision.
//
//   A · CHAINS, QUIET — Ableton's chain list at Traktor's visual weight. A chain is one line: a
//       thin edge in its source colour, a name, and a small source label (ALL / DRUM / VOICE
//       +INST). The four sends open only when you touch that label. The device list is the
//       biggest thing in the card, because it is what you came for.
//
//   B · TARGETED PRESETS — djay's model, and the only candidate that adds NO new surface at all.
//       The stem lives in the effect's name and a coloured tag; VOX ECHO sits in the bank next to
//       ECHO. There is nothing to route, nothing to reorder, nothing that lays out differently on
//       a phone. The cost is that you get the combinations someone shipped, not arbitrary ones —
//       a preset-authoring problem rather than a UI one.

const LANES = [
  { id: "drums", label: "DRUM", color: "#ff5d73" },
  { id: "bass", label: "BASS", color: "#b06bff" },
  { id: "vocals", label: "VOICE", color: "#5dff9e" },
  { id: "other", label: "INST", color: "#36c2ff" },
] as const;
type LaneId = (typeof LANES)[number]["id"];
type Sends = Record<LaneId, number>;
const laneOf = (id: LaneId) => LANES.find((l) => l.id === id)!;
const ALL: Sends = { drums: 1, bass: 1, vocals: 1, other: 1 };
const NONE: Sends = { drums: 0, bass: 0, vocals: 0, other: 0 };

// "ALL" / "DRUM" / "VOICE +INST" — the summary that replaces four coloured panels in the common
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
  { id: "mix", name: "MIX", sends: { ...ALL }, devices: ["EQ", "SAT", "COMP"] },
  { id: "a", name: "DRUM CHOP", sends: { ...NONE, drums: 1 }, devices: ["GATE", "CRUSH"] },
  { id: "b", name: "VOX AIR", sends: { ...NONE, vocals: 1, other: 0.4 }, devices: ["REVERB", "DELAY"] },
  { id: "c", name: "RISER", sends: { ...NONE }, devices: ["NOISE"], gen: true },
];

interface Preset {
  name: string;
  device: string;
  stem?: LaneId;
}
const PRESETS: Preset[] = [
  { name: "ECHO", device: "DELAY" },
  { name: "VERB", device: "REVERB" },
  { name: "SAT", device: "SAT" },
  { name: "CRUSH", device: "CRUSH" },
  { name: "GATE", device: "GATE" },
  { name: "RISER", device: "NOISE" },
  { name: "VOX ECHO", device: "DELAY", stem: "vocals" },
  { name: "VOX AIR", device: "REVERB", stem: "vocals" },
  { name: "DRUM CHOP", device: "GATE", stem: "drums" },
  { name: "DRUM CRUSH", device: "CRUSH", stem: "drums" },
  { name: "BASS GRIT", device: "SAT", stem: "bass" },
  { name: "INST WASH", device: "REVERB", stem: "other" },
];

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
  const [view, setView] = useState<"a" | "b">("a");
  const [width, setWidth] = useState(0);
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
  // simulated width and its own breakpoints fire. A transform scales pixels and leaves a 2560 px
  // layout box behind.
  const zoom = width && avail && width > avail ? avail / width : 1;

  const body = (
    <div className={`rl ${full ? "rl-full" : ""}`}>
      <div className="rl-head">
        <div className="rl-views">
          <button className={view === "a" ? "active" : ""} onClick={() => setView("a")}>
            A · chains
          </button>
          <button className={view === "b" ? "active" : ""} onClick={() => setView("b")}>
            B · targeted presets
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
          {view === "a" ? <ChainsView sim={width} /> : <TargetsView sim={width} />}
        </div>
      </div>
      <p className="rl-note">
        {view === "a" ? (
          <>
            <b>A · chains.</b> A chain is a stem send set plus a serial device list — the list is exactly the rack that ships
            today. The sources collapse to a label (<b>ALL</b>, <b>DRUM</b>, <b>VOICE +INST</b>); tap it to open the four
            sends. Ordering is never a question because every chain is linear, and a generator is simply a chain with no input.
          </>
        ) : (
          <>
            <b>B · targeted presets.</b> No routing surface at all: the stem is part of the effect's identity, so VOX ECHO sits
            in the bank beside ECHO and you throw it the same way. Nothing to reorder, nothing that lays out differently on a
            phone. The cost is the combinations someone shipped rather than arbitrary ones.
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

function useCols(sim: number, at: number) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(1200);
  useEffect(() => {
    const el = box.current;
    if (!el || sim) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [sim]);
  return { box, wide: (sim || w) >= at };
}

function ChainsView({ sim }: { sim: number }) {
  const { box, wide } = useCols(sim, 700);
  const [chains, setChains] = useState(CHAINS);
  const [open, setOpen] = useState<string | null>(null); // which chain's sends are being edited
  const setSend = (id: string, lane: LaneId) =>
    setChains((prev) =>
      prev.map((c) => (c.id !== id ? c : { ...c, sends: { ...c.sends, [lane]: c.sends[lane] === 0 ? 0.4 : c.sends[lane] < 1 ? 1 : 0 } })),
    );

  return (
    <div ref={box} className={`rl-chains ${wide ? "wide" : ""}`}>
      {chains.map((c) => {
        const d = describe(c.sends);
        return (
          <div key={c.id} className={`rl-chain ${c.gen ? "gen" : ""}`}>
            {/* ★ ONE LINE. The colour is a 3px edge, not a fill: routing is state you GLANCE at,
                and sixteen saturated blocks made it the loudest thing in the room. */}
            <div className="rl-chain-head" style={{ ["--edge" as string]: c.gen ? "#ffb03a" : d.colors[0] ?? "var(--line)" }}>
              <span className="rl-chain-name">{c.name}</span>
              {c.gen ? (
                <span className="rl-src gen">GEN</span>
              ) : (
                <button className={`rl-src ${open === c.id ? "open" : ""}`} onClick={() => setOpen(open === c.id ? null : c.id)}>
                  <span className="rl-src-dots">
                    {d.colors.map((col, i) => (
                      <i key={i} style={{ background: col }} />
                    ))}
                  </span>
                  {d.text}
                </button>
              )}
            </div>
            {open === c.id && !c.gen && (
              <div className="rl-sends">
                {LANES.map((l) => {
                  const v = c.sends[l.id];
                  return (
                    <button key={l.id} className={`rl-send ${v ? "on" : ""}`} style={{ ["--lane" as string]: l.color }} onClick={() => setSend(c.id, l.id)}>
                      <span className="rl-send-bar">
                        <i style={{ width: `${Math.round(v * 100)}%` }} />
                      </span>
                      <span className="rl-send-lab">{l.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="rl-devs">
              {c.devices.map((dev, i) => (
                <div key={`${dev}${i}`} className="rl-dev">
                  <span className="rl-grip">⠿</span>
                  <span className="rl-dev-name">{dev}</span>
                </div>
              ))}
              <button className="rl-adddev">+ device</button>
            </div>
          </div>
        );
      })}
      <button className="rl-newchain">+ chain</button>
    </div>
  );
}

function TargetsView({ sim }: { sim: number }) {
  const { box, wide } = useCols(sim, 620);
  const [sel, setSel] = useState("VOX ECHO");
  return (
    <div ref={box} className={`rl-targets ${wide ? "wide" : ""}`}>
      {PRESETS.map((p) => {
        const l = p.stem ? laneOf(p.stem) : null;
        return (
          <button
            key={p.name}
            className={`rl-tile ${sel === p.name ? "active" : ""} ${l ? "targeted" : ""}`}
            style={l ? ({ ["--lane" as string]: l.color } as React.CSSProperties) : undefined}
            onClick={() => setSel(p.name)}
          >
            <span className="rl-tile-name">{p.name}</span>
            <span className="rl-tile-sub">{l ? l.label : "FULL"}</span>
          </button>
        );
      })}
    </div>
  );
}
