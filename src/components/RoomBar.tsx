import { useState } from "react";
import type { RoomState } from "@htl/room";
import { maskName, toggleRevealed, usePrivacyRevealed } from "@htl/privacy";

// Chin control for the shared DJ session — the LOBBY.
//
// Two distinct stages, so nothing implies sync that doesn't exist yet:
//   1) DISCOVERY — your signed-in devices see each other but are NOT synced. One clear
//      action: Start session (you host) / Join session (one's live). No per-device
//      switches (they'd be meaningless).
//   2) IN A SESSION — once ≥2 devices are actually joined, each shows two INDEPENDENT
//      switches: 🎛️ drive and 🔊 sound. Alone in a session → switches hidden (waiting).
// Names are masked for streaming privacy (owner's own only) behind a 👁 toggle.
export function RoomBar({ room, onActivate }: { room: RoomState; onActivate?: () => void }) {
  const [open, setOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [inviting, setInviting] = useState(false);
  const revealed = usePrivacyRevealed();

  const online = room.status === "online";
  const inSession = room.signedIn || room.isGuest;
  const others = room.peers.filter((p) => p.id !== room.you);
  const participants = room.peers.filter((p) => p.joined);
  const sessionLive = participants.length > 0;
  // Switches only mean something with a real, multi-device synced session.
  const showSwitches = room.joined && participants.length >= 2;

  const dot = !inSession
    ? "idle"
    : !online
      ? room.status === "error"
        ? "error"
        : "connecting"
      : room.joined
        ? "online"
        : "idle";

  let chipCls = "idle";
  let chipText = "Solo";
  if (inSession && !online) {
    chipCls = "wait";
    chipText = room.status === "error" ? "Offline" : "Connecting…";
  } else if (room.joined) {
    chipCls = "ok";
    chipText =
      participants.length < 2 ? "Waiting…" : room.controlling ? "Driving" : room.listening ? "🔒 Listening" : "🔇 Muted";
  } else if (sessionLive) {
    chipText = "Live";
  }

  async function makeInvite() {
    setInviting(true);
    const inv = await room.createInvite();
    setInviting(false);
    if (inv) {
      setInviteUrl(inv.url);
      try {
        await navigator.clipboard.writeText(inv.url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      } catch {
        /* clipboard blocked — the link is shown for manual copy */
      }
    }
  }

  // Start = host a fresh session and drive it; Join = sync into a live one as a listener.
  // Resume the audio context INSIDE the click gesture — iOS only unlocks audio from a
  // direct user gesture, so doing it in an effect leaves a joined device silent (bug #3).
  const startSession = () => {
    onActivate?.();
    room.join();
    room.setControl(true); // the starter drives…
    room.setListening(true); // …and hears, by default
  };
  // A joiner syncs SILENT + not driving by default — they opt into 🔊 (self) and the host
  // opts them into 🎛️.
  const joinSession = () => {
    onActivate?.();
    room.join();
  };

  return (
    <div className="room">
      <button
        className={`chin-btn chin-room ${open ? "active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-label="Shared session and devices"
        title="Shared DJ session"
      >
        <span className={`chin-room-i ${dot}`} aria-hidden="true">⇅</span>
        {others.length > 0 && <span className="room-count">{others.length}</span>}
      </button>

      {open && (
        <>
          <div className="room-catch" onClick={() => setOpen(false)} />
          <div className="room-pop" onClick={(e) => e.stopPropagation()}>
            {!inSession ? (
              <p className="room-hint">
                Sign in under <strong>Settings ▸ Accounts</strong>, or open an invite link, to join a shared session.
              </p>
            ) : (
              <>
                <div className="room-sesh">
                  <div className="room-sesh-head">
                    <span className="room-sesh-title">{room.isGuest ? "Guest session" : "Session"}</span>
                    <span className="room-sesh-tools">
                      <button
                        className={`room-eye ${revealed ? "on" : ""}`}
                        onClick={toggleRevealed}
                        title={revealed ? "Hide names (streaming-safe)" : "Reveal names"}
                        aria-label={revealed ? "Hide names" : "Reveal names"}
                      >
                        {revealed ? "🙈" : "👁"}
                      </button>
                      <span className={`room-status ${chipCls}`}>{chipText}</span>
                    </span>
                  </div>
                  {room.joined && participants.length < 2 && (
                    <p className="room-sesh-sub">Waiting for another device to join…</p>
                  )}
                </div>

                <ul className="room-roster">
                  {room.peers.map((p) => (
                    <DeviceRow key={p.id} room={room} p={p} revealed={revealed} showSwitches={showSwitches} onActivate={onActivate} />
                  ))}
                  {others.length === 0 && !sessionLive && (
                    <li className="room-ghost">
                      <span className="room-dev-ico" aria-hidden="true">＋</span>
                      <span>Open htl on another device on this account, or invite someone.</span>
                    </li>
                  )}
                </ul>

                <div className="room-foot">
                  {!room.joined ? (
                    sessionLive ? (
                      <button className="room-cta" onClick={joinSession} title="Sync in as a listener — then tap 🎛️ on your row to take the decks">
                        Join session
                      </button>
                    ) : (
                      <button className="room-cta" onClick={startSession} title="Host a new session and drive the decks (others join as listeners)">
                        Start session
                      </button>
                    )
                  ) : (
                    <button className="room-unlink" onClick={room.leave}>
                      Leave session
                    </button>
                  )}

                  {!room.isGuest && room.signedIn && (
                    <button className="room-invite" onClick={makeInvite} disabled={inviting}>
                      {inviting ? "Creating link…" : copied ? "Link copied ✓" : "Invite people"}
                    </button>
                  )}
                  {inviteUrl && (
                    <div className="room-invite-link" title={inviteUrl}>
                      {inviteUrl.replace(/^https?:\/\//, "")}
                    </div>
                  )}
                </div>

                {room.error && <p className="room-err">{room.error}</p>}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function DeviceRow({
  room,
  p,
  revealed,
  showSwitches,
  onActivate,
}: {
  room: RoomState;
  p: RoomState["peers"][number];
  revealed: boolean;
  showSwitches: boolean;
  onActivate?: () => void;
}) {
  const isSelf = p.id === room.you;
  const isGuest = !p.host;
  const label = isSelf ? "self" : isGuest || revealed ? p.name : maskName(p.name);
  // Your OWN switches appear the moment you're joined — even waiting alone — so you can
  // pre-set drive/sound and the card stops reading like plain discovery (bug #13). Other
  // devices' switches still wait for a real ≥2 session.
  const rowSwitches = p.joined && (showSwitches || isSelf);

  // 🎛️ drive — ACCOUNT-based: a host device flips its own + grants/revokes any guest; a
  // guest can only turn its OWN off (the host grants it on).
  let ctl: { interactive: boolean; locked: boolean; on: () => void; title: string };
  if (isSelf) {
    if (room.host) ctl = { interactive: true, locked: false, on: () => room.setControl(!p.controlling), title: p.controlling ? "Stop driving" : "Drive the decks" };
    else if (p.controlling) ctl = { interactive: true, locked: false, on: () => room.setControl(false), title: "Stop driving" };
    else ctl = { interactive: false, locked: true, on: () => {}, title: "Only the host can hand you the decks" };
  } else if (room.host) {
    ctl = { interactive: true, locked: false, on: () => room.grantControl(p.id, !p.controlling), title: p.controlling ? "Revoke control" : "Give control" };
  } else {
    ctl = { interactive: false, locked: false, on: () => {}, title: p.controlling ? "Driving" : "Not driving" };
  }

  // 🔊 sound is DEVICE-LOCAL: only the device itself can mute/unmute — never another.
  const toggleSound = () => {
    if (!p.listening) onActivate?.(); // unmuting must resume the audio context IN the gesture (iOS)
    room.setListening(!p.listening);
  };

  return (
    <li className={`room-card ${p.joined ? "in" : ""} ${isSelf ? "self" : ""} ${isGuest ? "guest" : ""}`}>
      <span className="room-card-ico" aria-hidden="true">{deviceIcon(p.kind)}</span>
      <div className="room-card-main">
        <div className="room-card-id">
          <span className="room-dev-name">{label}</span>
          {p.host ? <span className="room-host-tag">host</span> : <span className="room-guest-tag">guest</span>}
        </div>
        <div className="room-card-foot">
          {rowSwitches ? (
            <span className="room-row-tog">
              <Switch glyph="🎛️" on={p.controlling} interactive={ctl.interactive} locked={ctl.locked} onClick={ctl.on} title={ctl.title} />
              <Switch
                glyph={p.listening ? "🔊" : "🔇"}
                on={p.listening}
                interactive={isSelf}
                locked={false}
                onClick={toggleSound}
                title={isSelf ? (p.listening ? "Mute this device" : "Hear the mix") : p.listening ? "Hearing" : "Muted"}
              />
            </span>
          ) : (
            <span className="room-row-status">{isSelf ? "this device" : p.joined ? "in session" : "discovered"}</span>
          )}
        </div>
      </div>
    </li>
  );
}

function Switch({
  glyph,
  on,
  interactive,
  locked,
  onClick,
  title,
}: {
  glyph: string;
  on: boolean;
  interactive: boolean;
  locked: boolean;
  onClick: () => void;
  title: string;
}) {
  if (interactive) {
    return (
      <button className={`room-tog ${on ? "on" : ""}`} onClick={onClick} title={title} aria-pressed={on}>
        {glyph}
      </button>
    );
  }
  if (locked) {
    return (
      <button className="room-tog locked" disabled title={title}>
        {glyph}
      </button>
    );
  }
  return (
    <span className={`room-tog static ${on ? "on" : ""}`} title={title} aria-hidden="true">
      {glyph}
    </span>
  );
}

// Roster icon from the DEVICE TYPE (iPhone / Android / Mac / Linux …), not the name.
function deviceIcon(kind: string): string {
  return /iphone|ipad|android|phone|mobile|tablet/i.test(kind) ? "📱" : "💻";
}
