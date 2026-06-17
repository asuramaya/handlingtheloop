import { type FormEvent, useEffect, useRef, useState } from "react";
import { type RoomState, REACTIONS } from "@htl/room";

// Crowd reactions (F4) + hype meter (F2). Everyone present taps the emoji row; the DO
// aggregates and flushes a hype level + per-emoji counts, which we render as a filling bar
// plus a short burst of floating emojis. The DJ reads the bar as live crowd energy. A tuned-in
// listener also gets the "request a song" form (F1) here; the host sees the list in the body.
export function CrowdPanel({ room }: { room: RoomState }) {
  const [sprites, setSprites] = useState<{ id: number; emoji: string; x: number }[]>([]);
  const [reqText, setReqText] = useState("");
  const [reqSent, setReqSent] = useState(false);
  const seen = useRef(0);
  const submitRequest = (e: FormEvent) => {
    e.preventDefault();
    const t = reqText.trim();
    if (!t) return;
    room.requestSong(t);
    setReqText("");
    setReqSent(true);
    setTimeout(() => setReqSent(false), 2400);
  };
  const { id, counts } = room.reactionTick;
  useEffect(() => {
    if (id === seen.current) return;
    seen.current = id;
    const add: { id: number; emoji: string; x: number }[] = [];
    let k = 0;
    for (const [emoji, n] of Object.entries(counts)) {
      for (let i = 0; i < Math.min(n, 6); i++) {
        add.push({ id: id * 1000 + k++, emoji, x: 6 + Math.floor(Math.random() * 86) });
      }
    }
    if (!add.length) return;
    setSprites((s) => [...s.slice(-40), ...add]);
    const ids = new Set(add.map((a) => a.id));
    const t = setTimeout(() => setSprites((s) => s.filter((sp) => !ids.has(sp.id))), 1500);
    return () => clearTimeout(t);
  }, [id, counts]);

  const pct = Math.round(room.hype * 100);
  return (
    <div className="crowd-panel">
      <div className="hype-row">
        <span className="hype-label">Hype</span>
        <div className={`hype-bar ${pct >= 70 ? "hot" : ""}`}>
          <div className="hype-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="hype-sprites" aria-hidden="true">
          {sprites.map((s) => (
            <span key={s.id} className="hype-sprite" style={{ left: `${s.x}%` }}>{s.emoji}</span>
          ))}
        </div>
      </div>
      <div className="react-bar">
        {REACTIONS.map((e) => (
          <button key={e} className="react-btn" onClick={() => room.react(e)} aria-label={`React ${e}`}>
            {e}
          </button>
        ))}
      </div>
      {/* Listeners ask the DJ for a song (F1). Hosts see the list instead, in the body. */}
      {room.listeningTo && (
        <form className="request-form" onSubmit={submitRequest}>
          <input
            className="request-input"
            value={reqText}
            onChange={(e) => setReqText(e.target.value)}
            placeholder={reqSent ? "✓ Sent to the DJ" : "Request a song…"}
            maxLength={120}
            aria-label="Request a song"
          />
          <button className="request-send" type="submit" disabled={!reqText.trim()}>
            Request
          </button>
        </form>
      )}
    </div>
  );
}
