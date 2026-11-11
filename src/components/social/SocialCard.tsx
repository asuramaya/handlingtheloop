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
  // ★ CHIPS, NOT A SENTENCE OF EMOJI (operator, 2026-11-11: "an eye sore… hard to understand at
  // first glance"). "🎛️ driving · 🔇 muted · clock" asked the reader to decode three glyphs and a
  // word that meant nothing to them; each fact is now a small labelled chip, and "clock" (the
  // device whose playhead everyone follows) says what it is.
  const chips: { k: string; label: string; on: boolean; title: string }[] = !p.joined
    ? [{ k: "seen", label: "Not joined", on: false, title: "Signed in on this account but not in the session" }]
    : [
        ...(p.stage ? [{ k: "stage", label: "On stage", on: true, title: "Stepped up from the crowd" }] : []),
        p.controlling
          ? { k: "drive", label: p.stage && (p.decks === "A" || p.decks === "B") ? `Deck ${p.decks}` : "Decks", on: true, title: "Can drive the decks" }
          : { k: "drive", label: "Watching", on: false, title: "Follows the decks, cannot drive them" },
        p.listening
          ? { k: "sound", label: "Sound on", on: true, title: "Plays the mix out loud" }
          : { k: "sound", label: "Muted", on: false, title: "Follows silently" },
        ...(p.anchor ? [{ k: "clock", label: "Timekeeper", on: true, title: "Everyone's playhead follows this device" }] : []),
      ];

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
        <div className="social-card-role">
          {chips.map((c) => (
            <span key={c.k} className={`room-chip ${c.k} ${c.on ? "on" : ""}`} title={c.title}>
              {c.label}
            </span>
          ))}
        </div>
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
