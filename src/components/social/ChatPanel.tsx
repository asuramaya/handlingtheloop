import { type FormEvent, useEffect, useRef, useState } from "react";
import { type RoomState, REACTIONS } from "@htl/room";
import { maskName } from "@htl/privacy";
import { fileReport } from "@htl/account";

// The crowd channel (F2/F4/F5 + L1 moderation) — ONE card. A live HYPE strip + reaction row sit
// atop the chat (no more header hype bar): tap a reaction → it feeds the meter + floats an emoji.
// Then the scrolling chat log + composer; the host gets a slow-mode selector (incl. Off) and
// per-message mute/remove. A tuned-in listener also gets the song-request form here. Hype +
// reactions only show in a BROADCAST (you host one, or you've tuned in) — a plain multi-device
// session is just chat.
const SLOW_OPTS = [
  { v: -1, l: "Off", t: "Turn chat off" },
  { v: 0, l: "On", t: "Chat on (anti-spam floor only)" },
  { v: 5, l: "5s", t: "Slow mode — one line per 5s" },
  { v: 15, l: "15s", t: "Slow mode — one line per 15s" },
] as const;

export function ChatPanel({ room, revealed }: { room: RoomState; revealed: boolean }) {
  const [text, setText] = useState("");
  const [reported, setReported] = useState<Set<string>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);
  const crowd = room.roomPublic || !!room.listeningTo; // a broadcast is happening → show hype/reactions

  // Floating-emoji burst on each reaction frame (F4), feeding the hype bar (F2).
  const [sprites, setSprites] = useState<{ id: number; emoji: string; x: number }[]>([]);
  const seen = useRef(0);
  const { id: rid, counts } = room.reactionTick;
  useEffect(() => {
    if (rid === seen.current) return;
    seen.current = rid;
    const add: { id: number; emoji: string; x: number }[] = [];
    let k = 0;
    for (const [emoji, n] of Object.entries(counts)) {
      for (let i = 0; i < Math.min(n, 6); i++) add.push({ id: rid * 1000 + k++, emoji, x: 6 + Math.floor(Math.random() * 86) });
    }
    if (!add.length) return;
    setSprites((s) => [...s.slice(-40), ...add]);
    const ids = new Set(add.map((a) => a.id));
    const t = setTimeout(() => setSprites((s) => s.filter((sp) => !ids.has(sp.id))), 1500);
    return () => clearTimeout(t);
  }, [rid, counts]);

  // Listener → DJ song request (F1).
  const [reqText, setReqText] = useState("");
  const [reqSent, setReqSent] = useState(false);
  const submitRequest = (e: FormEvent) => {
    e.preventDefault();
    const t = reqText.trim();
    if (!t) return;
    room.requestSong(t);
    setReqText("");
    setReqSent(true);
    setTimeout(() => setReqSent(false), 2400);
  };

  const report = (m: { id: string; dev: string; text: string }) => {
    void fileReport({ kind: "chat", room: room.listeningTo ?? undefined, dev: m.dev, text: m.text });
    setReported((s) => new Set(s).add(m.id)); // optimistic — flag stays marked
  };
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [room.chatLog.length]);

  const off = room.chatSlow < 0;
  const locked = off || room.iAmMuted;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    room.sendChat(t);
    setText("");
  };
  const placeholder = off ? "Chat is off" : room.iAmMuted ? "You're muted" : room.chatSlow > 0 ? `Slow mode · ${room.chatSlow}s` : "Say something…";
  const pct = Math.round(room.hype * 100);

  return (
    <div className="chat-panel">
      {crowd && (
        <>
          <div className="hype-row">
            <span className="hype-label">🔥 Hype</span>
            <div className={`hype-bar ${pct >= 70 ? "hot" : ""}`}>
              <div className="hype-fill" style={{ width: `${pct}%` }} />
              <div className="hype-sprites" aria-hidden="true">
                {sprites.map((s) => (
                  <span key={s.id} className="hype-sprite" style={{ left: `${s.x}%` }}>
                    {s.emoji}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="react-bar">
            {REACTIONS.map((e) => (
              <button key={e} className="react-btn" onClick={() => room.react(e)} aria-label={`React ${e}`}>
                {e}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="social-section-head chat-head">
        💬 Chat
        {room.host && (
          <span className="chat-slow-sel" role="group" aria-label="Chat mode">
            {SLOW_OPTS.map((o) => (
              <button
                key={o.v}
                className={`chat-slow-opt ${room.chatSlow === o.v ? "on" : ""}`}
                onClick={() => room.setChatSlow(o.v)}
                title={o.t}
                aria-pressed={room.chatSlow === o.v}
              >
                {o.l}
              </button>
            ))}
          </span>
        )}
      </div>
      <div className="chat-log">
        {room.chatLog.length === 0 && <div className="chat-empty">No messages yet — say hi 👋</div>}
        {room.chatLog.map((m) => {
          const self = m.dev === room.you;
          return (
            <div key={m.id} className={`chat-line ${self ? "self" : ""}`}>
              <span className="chat-who">{self ? "You" : revealed ? m.name : maskName(m.name)}</span>
              <span className="chat-text">{m.text}</span>
              {room.host && !self && (
                <span className="chat-mod">
                  {room.mutedDevices.has(m.dev) ? (
                    <button className="chat-mute on" onClick={() => room.muteDevice(m.dev, false)} title="Unmute this person" aria-label="Unmute">🔊</button>
                  ) : (
                    <button className="chat-mute" onClick={() => room.muteDevice(m.dev, true)} title="Mute this person" aria-label="Mute">🔇</button>
                  )}
                  <button className="chat-ban" onClick={() => room.banDevice(m.dev)} title="Remove from the room" aria-label="Remove">⛔</button>
                </span>
              )}
              {/* Non-hosts can report a message to moderation (the host moderates directly). */}
              {!room.host && !self && (
                <span className="chat-mod">
                  <button
                    className="chat-ban"
                    onClick={() => report(m)}
                    disabled={reported.has(m.id)}
                    title={reported.has(m.id) ? "Reported" : "Report to moderators"}
                    aria-label="Report"
                  >
                    {reported.has(m.id) ? "✓" : "⚑"}
                  </button>
                </span>
              )}
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {/* Listener → DJ song request (F1) — a clearly-labelled suggest box, distinct from chat.
          The host sees the crowd-ranked list + a ＋ Queue action in the body. */}
      {room.listeningTo && (
        <div className="suggest-box">
          <div className="suggest-head">🎵 Suggest a song to the DJ</div>
          <form className="request-form" onSubmit={submitRequest}>
            <input
              className="request-input"
              value={reqText}
              onChange={(e) => setReqText(e.target.value)}
              placeholder={reqSent ? "✓ Sent to the DJ" : "Artist — title…"}
              maxLength={120}
              aria-label="Suggest a song"
            />
            <button className="request-send" type="submit" disabled={!reqText.trim()}>
              Suggest
            </button>
          </form>
        </div>
      )}

      <form className="chat-form" onSubmit={submit}>
        <input
          className="chat-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={300}
          placeholder={placeholder}
          disabled={locked}
          aria-label="Chat message"
        />
        <button className="chat-send" type="submit" disabled={locked || !text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
