import { REASON_LABEL, type Reason } from "@htl/account";
import type { LiveRoom } from "@htl/account";

// One live-room row — shared by Discover's "live now" lists and the notification bell's
// "Live now" section so they render identically (avatar, name, now-playing, listener count).
// Tap behaviour is the caller's (Discover tunes in / goes to your own profile; the bell tunes
// in + closes).
export function LiveRoomRow({
  room: r,
  self,
  tunedTo,
  onTap,
  reason,
}: {
  room: LiveRoom;
  self: string | null;
  tunedTo: string | null;
  onTap: (handle: string) => void;
  // WHY this row is where it is. One ranked list only reads as ranked if each row can say what
  // put it there; without this the order is invisible and the list looks arbitrary.
  reason?: Reason;
}) {
  return (
    <li className={`live-room ${r.handle === tunedTo ? "tuned" : ""}`} onClick={() => onTap(r.handle)}>
      {r.avatar ? (
        <img className="live-room-avatar" src={r.avatar} alt="" loading="lazy" />
      ) : (
        <span className="live-room-avatar fallback" aria-hidden="true">
          {(r.displayName || r.handle).slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="live-room-main">
        <span className="live-room-name">
          {r.displayName || `@${r.handle}`}
          {r.handle === self && <span className="live-room-you"> (you)</span>}
        </span>
        <span className="live-room-np">
          {r.npTitle ? `${r.npArtist ? `${r.npArtist} · ` : ""}${r.npTitle}` : `@${r.handle}`}
        </span>
      </span>
      <span className="live-room-meta">
        {reason && <span className={`live-room-why ${reason}`}>{REASON_LABEL[reason]}</span>}
        <span className="live-room-count">{r.listeners} 🎧</span>
      </span>
    </li>
  );
}
