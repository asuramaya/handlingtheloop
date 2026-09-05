import type { RoomState } from "@htl/room";
import { maskName } from "@htl/privacy";
import { ago, deviceIcon } from "./util";

// One roster row: who the device is, what it's doing (driving / hearing / on stage / clock),
// and the self-switches + host moderation that apply to it.
export function SocialCard({
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

  // Role line: what this device is doing right now. A stepped-up listener shows the deck
  // they hold (🎛️ Deck B) so a b2b is legible at a glance.
  const driveLabel = p.controlling ? (p.stage && (p.decks === "A" || p.decks === "B") ? `🎛️ Deck ${p.decks}` : "🎛️ driving") : null;
  const role = !p.joined
    ? "discovered"
    : [p.stage ? "● stage" : null, driveLabel, p.listening ? "🔊 hearing" : "🔇 muted", p.anchor ? "clock" : null]
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
              aria-label={p.listening ? "Mute this device" : "Hear the mix"}
            >
              {p.listening ? "🔊" : "🔇"}
            </button>
          </>
        )}
        {canModerate && (
          <>
            {/* A stepped-up listener gets a gentle "send to the floor" (keeps them listening);
                an invited guest gets the usual grant + kick. */}
            {p.stage ? (
              <button className="social-floor" onClick={() => room.denyStage(p.id)}>
                ⬇ floor
              </button>
            ) : (
              p.joined && (
                <button
                  className={`room-tog ${p.controlling ? "on" : ""}`}
                  onClick={() => room.grantControl(p.id, !p.controlling)}
                  title={p.controlling ? "Revoke control" : "Give control"}
                >
                  🎛️
                </button>
              )
            )}
            <button className="social-kick" onClick={() => room.kick(p.id)}>
              ⛔
            </button>
          </>
        )}
      </div>
    </li>
  );
}
