import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// RACKLAB — an UNWIRED layout prototype for stem-routed FX. No audio, no rack, no routing.
//
// ★ THE UNIT OF ROUTING IS A CHAIN, NOT A DEVICE. The first version of this put a stem×device grid
// in the rack — a sum line, a dot per lane per device — and it was wrong. Four references solve
// this problem and NOT ONE of them routes per device:
//
//   • Ableton — an Audio Effect Rack holds parallel CHAINS; each chain gets the same input and
//     runs it serially through its OWN devices, and the chains mix at the output. You pick a chain
//     from a list. There is no per-device routing anywhere in it.
//   • FL Studio — channels route to mixer INSERTS, each insert a serial FX slot list pointing at
//     another insert or the master; shared effects are send knobs. Routing is a mixer concern.
//   • Traktor Stem Decks — the closest prior art: each stem carries VOLUME, FILTER and FX SEND.
//     The routing control lives ON THE STEM, as an amount.
//   • djay Pro AI — stem-specific effects are assigned to PADS: the stem is part of the effect's
//     identity, not a separate routing decision.
//
// The grid was making the plumbing legible instead of making it disappear. So: a CHAIN is a stem
// SEND SET plus a serial device list, and the device list is exactly the rack that ships today —
// same tabs, same panels, same order, nothing new to lay out. Ordering stops being a question
// because every chain is linear. A generator is simply a chain with no input. And the default
// state IS today: one chain, fed by everything.
//
// The trade, stated plainly: two devices in the same chain always hear the same stems. "Gate the
// drums and reverb the vocals" costs a second CHAIN rather than a second row of dots — which is
// exactly what it costs in all four references.

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

interface Chain {
  id: string;
  name: string;
  sends: Sends;
  devices: string[];
  gen?: boolean; // a generator chain: produces, takes no input — the sends strip is meaningless
}

const INITIAL: Chain[] = [
  { id: "mix", name: "MIX", sends: { ...ALL }, devices: ["EQ", "SAT", "COMP"] },
  { id: "a", name: "DRUM CHOP", sends: { ...NONE, drums: 1 }, devices: ["GATE", "CRUSH"] },
  { id: "b", name: "VOX AIR", sends: { ...NONE, vocals: 1, other: 0.4 }, devices: ["REVERB", "DELAY"] },
  { id: "c", name: "RISER", sends: { ...NONE }, devices: ["NOISE"], gen: true },
];

const PALETTE = ["EQ", "DELAY", "REVERB", "SAT", "CRUSH", "MOD", "GATE", "COMP"];

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
  const [chains, setChains] = useState<Chain[]>(INITIAL);
  const [sel, setSel] = useState("mix");
  const [width, setWidth] = useState(0);
  const [full, setFull] = useState(false);

  // ★ Zoom-to-fit, and `zoom` rather than `transform: scale`. A simulated 2560 px rack does not fit
  // in a 440 px settings panel; clamping it would make the ruler lie, and a scrollbar would mean
  // judging a wide layout through a letterbox. `zoom` scales LAYOUT, so the rack still measures its
  // simulated width and its own breakpoints fire; `transform` would scale pixels and leave a
  // 2560 px layout box behind.
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

  const setSend = (id: string, lane: LaneId) =>
    setChains((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        const v = c.sends[lane];
        const next = v === 0 ? 0.4 : v < 1 ? 1 : 0; // off → part → full → off
        return { ...c, sends: { ...c.sends, [lane]: next } };
      }),
    );
  const addChain = () =>
    setChains((prev) => {
      const id = `x${prev.length}`;
      setSel(id);
      return [...prev, { id, name: `CHAIN ${prev.length}`, sends: { ...NONE }, devices: [] }];
    });
  const moveDevice = (id: string, from: number, to: number) =>
    setChains((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        const d = c.devices.slice();
        const [x] = d.splice(from, 1);
        d.splice(Math.max(0, Math.min(d.length, to)), 0, x);
        return { ...c, devices: d };
      }),
    );
  const addDevice = (id: string, name: string) => setChains((prev) => prev.map((c) => (c.id === id ? { ...c, devices: [...c.devices, name] } : c)));
  const dropDevice = (id: string, i: number) => setChains((prev) => prev.map((c) => (c.id === id ? { ...c, devices: c.devices.filter((_, k) => k !== i) } : c)));

  const body = (
    <div className={`rl ${full ? "rl-full" : ""}`}>
      <div className="rl-head">
        <div className="rl-title">
          RACKLAB — chains, not a matrix (unwired)
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
          <ChainRack
            chains={chains}
            sel={sel}
            sim={width}
            onSel={setSel}
            onSend={setSend}
            onAdd={addChain}
            onMove={moveDevice}
            onAddDevice={addDevice}
            onDrop={dropDevice}
          />
        </div>
      </div>
      <p className="rl-note">
        A <b>chain</b> is a stem send set plus a serial device list — the device list is exactly the rack that ships today.
        Tap a send to cycle it off → part → full. Narrow shows one chain at a time; wide lays them side by side, which is what
        the extra width is actually for. Default state is one chain fed by everything, i.e. today.
      </p>
    </div>
  );
  // ★ Portalled to the body when expanded. The settings panel animates in with a TRANSFORM, and a
  // transformed ancestor becomes the containing block for position:fixed — so "full screen" was
  // full-settings-panel, 397 px wide, which is the one width it was built to escape.
  return full ? createPortal(body, document.body) : body;
}

function ChainRack(props: {
  chains: Chain[];
  sel: string;
  sim: number;
  onSel: (id: string) => void;
  onSend: (id: string, l: LaneId) => void;
  onAdd: () => void;
  onMove: (id: string, a: number, b: number) => void;
  onAddDevice: (id: string, n: string) => void;
  onDrop: (id: string, i: number) => void;
}) {
  const { chains, sel, sim } = props;
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
  const eff = sim || w;
  // ★ The ONLY width decision: one chain at a time, or all of them side by side. There is no third
  // layout and no re-flowed matrix — a wide screen shows MORE CHAINS, which is exactly how Ableton
  // uses width too. Below the threshold the chips are the navigation; above it they are redundant.
  // 700, not 1100: a tablet has room for two chains side by side, and one 768 px-wide chain is a
  // column of empty space with a device list down one edge. Above the threshold the count is left
  // to flex-wrap and a max-width per chain, so the layout keeps adding COLUMNS as width arrives
  // instead of stretching four of them into bands.
  const columns = eff >= 700;
  const shown = columns ? chains : chains.filter((c) => c.id === sel);

  return (
    <div ref={box} className={`rl-rack ${columns ? "rl-cols" : "rl-one"}`}>
      {!columns && (
        <div className="rl-chips">
          {chains.map((c) => (
            <button key={c.id} className={c.id === sel ? "active" : ""} onClick={() => props.onSel(c.id)}>
              <span className="rl-chip-dots">
                {LANES.map((l) => (
                  <i key={l.id} style={{ background: l.color, opacity: c.sends[l.id] ? 0.35 + 0.65 * c.sends[l.id] : 0.12 }} />
                ))}
              </span>
              {c.name}
            </button>
          ))}
          <button className="rl-add" onClick={props.onAdd} title="New chain">
            +
          </button>
        </div>
      )}
      <div className="rl-chainwrap">
        {shown.map((c) => (
          <ChainCard key={c.id} chain={c} {...props} />
        ))}
        {columns && (
          <button className="rl-newcol" onClick={props.onAdd}>
            + CHAIN
          </button>
        )}
      </div>
    </div>
  );
}

function ChainCard({
  chain,
  onSend,
  onMove,
  onAddDevice,
  onDrop,
}: {
  chain: Chain;
  onSend: (id: string, l: LaneId) => void;
  onMove: (id: string, a: number, b: number) => void;
  onAddDevice: (id: string, n: string) => void;
  onDrop: (id: string, i: number) => void;
}) {
  const drag = useRef<number | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const [pick, setPick] = useState(false);

  return (
    <div className={`rl-chain ${chain.gen ? "gen" : ""}`}>
      <div className="rl-chain-head">
        <span className="rl-chain-name">{chain.name}</span>
        {chain.gen && <i className="rl-tag">GEN</i>}
      </div>

      {/* THE SENDS — Traktor's placement: the routing is an AMOUNT on the stem, not a switch on the
          device. A generator chain has no input, so it says so rather than showing four dead sends. */}
      {chain.gen ? (
        <div className="rl-nosend">no input — generates</div>
      ) : (
        <div className="rl-sends">
          {LANES.map((l) => {
            const v = chain.sends[l.id];
            return (
              <button
                key={l.id}
                className={`rl-send ${v ? "on" : ""}`}
                style={{ ["--lane" as string]: l.color }}
                onClick={() => onSend(chain.id, l.id)}
                title={`${l.label} → this chain`}
              >
                <span className="rl-send-bar">
                  <i style={{ height: `${Math.round(v * 100)}%` }} />
                </span>
                <span className="rl-send-lab">{l.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* THE DEVICES — a plain serial list, which is the rack that already ships. */}
      <div
        className="rl-devs"
        ref={list}
        onPointerMove={(e) => {
          if (drag.current == null || !list.current) return;
          const y = e.clientY - list.current.getBoundingClientRect().top;
          const to = Math.floor(y / 26);
          if (to !== drag.current) {
            onMove(chain.id, drag.current, to);
            drag.current = Math.max(0, Math.min(chain.devices.length - 1, to));
          }
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        {chain.devices.map((d, i) => (
          <div key={`${d}${i}`} className="rl-dev">
            <span
              className="rl-grip"
              onPointerDown={(e) => {
                (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                drag.current = i;
              }}
            >
              ⠿
            </span>
            <span className="rl-dev-name">{d}</span>
            <button className="rl-x" onClick={() => onDrop(chain.id, i)} title="Remove">
              ✕
            </button>
          </div>
        ))}
        {!chain.devices.length && <div className="rl-empty">empty</div>}
      </div>

      {pick ? (
        <div className="rl-pick">
          {PALETTE.map((p) => (
            <button
              key={p}
              onClick={() => {
                onAddDevice(chain.id, p);
                setPick(false);
              }}
            >
              {p}
            </button>
          ))}
        </div>
      ) : (
        <button className="rl-adddev" onClick={() => setPick(true)}>
          + device
        </button>
      )}
    </div>
  );
}
