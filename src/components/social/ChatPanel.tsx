import { type FormEvent, useEffect, useRef, useState } from "react";
import type { RoomState } from "@htl/room";
import { maskName } from "@htl/privacy";
import { fileReport } from "@htl/account";

// Chat (F5) + host moderation (L1). A scrolling log + composer; the host gets a slow-mode
// selector (incl. Off) and per-message mute / remove. A muted device's composer locks; chat-off
// locks it for everyone. The crowd is anonymous, so moderation acts on the message's device id.
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

  return (
    <div className="chat-panel">
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
