import { useState } from "react";
import type { RoomState } from "@htl/room";
import { maskName, toggleRevealed, usePrivacyRevealed } from "@htl/privacy";
import { QRCode } from "./QRCode";

// The expanded session "social screen" — the full-screen surface behind the chin
// popup's Expand button. Everything social lives here: the live roster with roles +
// join times, the host's KNOCK REQUESTS (approve/deny — the handshake), per-device
// moderation (give/revoke control, kick), and the invite link + QR. The small popup
// stays as the quick glance; this is the room.
function ago(ms: number): string {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m in`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h in`;
  return `${Math.floor(h / 24)}d in`;
}
function deviceIcon(kind: string): string {
  return /iphone|ipad|android|phone|mobile|tablet/i.test(kind) ? "📱" : "💻";
}

export function SocialScreen({ room, onClose, onActivate }: { room: RoomState; onClose: () => void; onActivate?: () => void }) {
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [inviting, setInviting] = useState(false);
  const revealed = usePrivacyRevealed();

  const online = room.status === "online";
  const inSession = room.signedIn || room.isGuest;
  const others = room.peers.filter((p) => p.id !== room.you);
  const participants = room.peers.filter((p) => p.joined);
  const sessionLive = participants.length > 0;
  const knocks = room.host ? room.peers.filter((p) => p.pending) : [];

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — link + QR shown for manual copy/scan */
    }
  }
  async function makeInvite() {
    setInviting(true);
    const inv = await room.createInvite();
    setInviting(false);
    if (inv) {
      setInviteUrl(inv.url);
      await copyLink(inv.url);
    }
  }

  const startSession = () => {
    onActivate?.();
    room.join();
    room.setControl(true);
    room.setListening(true);
  };
  // Your OWN other device → control extension (drive on, silent); a guest → listener.
  const joinSession = () => {
    onActivate?.();
    room.join();
    if (room.host) room.setControl(true);
    else room.setListening(true);
  };

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="social-screen" onPointerDown={(e) => e.stopPropagation()}>
        <div className="social-head">
          <span className="social-title">{room.isGuest ? "Guest session" : "Session"}</span>
          <span className="social-head-tools">
            <button
              className={`room-eye ${revealed ? "on" : ""}`}
              onClick={toggleRevealed}
              title={revealed ? "Hide names (streaming-safe)" : "Reveal names"}
              aria-label={revealed ? "Hide names" : "Reveal names"}
            >
              {revealed ? "🙈" : "👁"}
            </button>
            <button className="profile-x" onClick={onClose} aria-label="Close session screen">
              ✕
            </button>
          </span>
        </div>

        {!inSession ? (
          <p className="social-hint">Sign in under Profile, or open an invite link, to join a shared session.</p>
        ) : (
          <div className="social-body">
            {room.pending && (
              <div className="social-waiting">⏳ Waiting for the host to let you in…</div>
            )}
            {!online && <div className="social-offline">{room.status === "error" ? "Offline — retrying…" : "Connecting…"}</div>}

            {knocks.length > 0 && (
              <div className="social-knocks">
                <div className="social-section-head">Wants to join</div>
                {knocks.map((p) => (
                  <div key={p.id} className="social-knock">
                    <span className="social-knock-ico" aria-hidden="true">{deviceIcon(p.kind)}</span>
                    <span className="social-knock-name">{revealed ? p.name : maskName(p.name)}</span>
                    <span className="social-knock-acts">
                      <button className="social-approve" onClick={() => room.approve(p.id)}>Let in</button>
                      <button className="social-deny" onClick={() => room.deny(p.id)}>Deny</button>
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="social-section-head">
              In the room{participants.length > 0 ? ` · ${participants.length}` : ""}
            </div>
            <ul className="social-roster">
              {room.peers
                .filter((p) => !p.pending)
                .map((p) => (
                  <SocialCard key={p.id} room={room} p={p} revealed={revealed} onActivate={onActivate} />
                ))}
              {others.length === 0 && !sessionLive && (
                <li className="social-ghost">Open htl on another device on this account, or invite someone below.</li>
              )}
            </ul>

            <div className="social-foot">
              {!room.joined ? (
                !online ? (
                  <button className="room-cta" disabled>
                    {room.status === "error" ? "Offline — retrying…" : "Connecting…"}
                  </button>
                ) : room.pending ? (
                  <button className="room-cta" disabled>Waiting for approval…</button>
                ) : sessionLive ? (
                  <button className="room-cta" onClick={joinSession} title={room.host ? "Join as a remote control — your master device keeps the audio" : "Join as a listener — the host can hand you the decks"}>
                    {room.host ? "Join as remote" : "Join session"}
                  </button>
                ) : (
                  <button className="room-cta" onClick={startSession}>Start session</button>
                )
              ) : (
                <button className="room-unlink" onClick={room.leave}>Leave session</button>
              )}

              {!room.isGuest && room.signedIn && (
                <div className="social-invite">
                  <button className="room-invite" onClick={makeInvite} disabled={inviting}>
                    {inviting ? "Creating link…" : copied ? "Link copied ✓" : "Invite people"}
                  </button>
                  {inviteUrl && (
                    <div className="room-invite-share">
                      <button type="button" className="room-invite-link" title="Tap to copy" onClick={() => copyLink(inviteUrl)}>
                        {copied ? "Link copied ✓" : inviteUrl.replace(/^https?:\/\//, "")}
                      </button>
                      <QRCode value={inviteUrl} size={172} className="room-invite-qr" />
                      <span className="room-invite-scan">Scan to join on another device</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {room.error && <p className="room-err">{room.error}</p>}
      </div>
    </div>
  );
}

function SocialCard({
  room,
  p,
  revealed,
  onActivate,
}: {
  room: RoomState;
  p: RoomState["peers"][number];
  revealed: boolean;
  onActivate?: () => void;
}) {
  const isSelf = p.id === room.you;
  const isGuest = !p.host;
  const label = isSelf ? "You" : isGuest || revealed ? p.name : maskName(p.name);

  // Role line: what this device is doing right now.
  const role = !p.joined
    ? "discovered"
    : [p.controlling ? "🎛️ driving" : null, p.listening ? "🔊 hearing" : "🔇 muted", p.anchor ? "clock" : null]
        .filter(Boolean)
        .join(" · ");

  // Self switches (own drive — host/granted only; own sound — always self).
  const toggleSelfSound = () => {
    if (!p.listening) onActivate?.();
    room.setListening(!p.listening);
  };
  const canSelfDrive = isSelf && (room.host || p.controlling);
  const toggleSelfDrive = () => room.setControl(!p.controlling);

  // Host moderation over OTHER guests: grant/revoke control, and kick.
  const canModerate = room.host && !isSelf && isGuest;

  return (
    <li
      className={`social-card ${p.joined ? "in" : ""} ${isSelf ? "self" : ""} ${isGuest ? "guest" : "host"}`}
      style={p.color ? { borderLeftColor: p.color, borderLeftWidth: 3 } : undefined}
    >
      <span className="social-card-ico" aria-hidden="true" style={p.color ? { color: p.color } : undefined}>
        {deviceIcon(p.kind)}
      </span>
      <div className="social-card-main">
        <div className="social-card-top">
          <span className="social-card-name">{label}</span>
          {p.host ? <span className="room-host-tag">host</span> : <span className="room-guest-tag">guest</span>}
          {p.joined && p.joinedAt > 0 && <span className="social-card-since">{ago(p.joinedAt)}</span>}
        </div>
        <div className="social-card-role">{role}</div>
      </div>
      <div className="social-card-acts">
        {isSelf && p.joined && (
          <>
            <button
              className={`room-tog ${p.controlling ? "on" : ""} ${canSelfDrive ? "" : "locked"}`}
              onClick={canSelfDrive ? toggleSelfDrive : undefined}
              disabled={!canSelfDrive}
              title={canSelfDrive ? (p.controlling ? "Stop driving" : "Drive the decks") : "The host hands you the decks"}
            >
              🎛️
            </button>
            <button
              className={`room-tog ${p.listening ? "on" : ""}`}
              onClick={toggleSelfSound}
              title={p.listening ? "Mute this device" : "Hear the mix"}
            >
              {p.listening ? "🔊" : "🔇"}
            </button>
          </>
        )}
        {canModerate && (
          <>
            {p.joined && (
              <button
                className={`room-tog ${p.controlling ? "on" : ""}`}
                onClick={() => room.grantControl(p.id, !p.controlling)}
                title={p.controlling ? "Revoke control" : "Give control"}
              >
                🎛️
              </button>
            )}
            <button className="social-kick" onClick={() => room.kick(p.id)} title="Remove from session">
              ⛔
            </button>
          </>
        )}
      </div>
    </li>
  );
}
