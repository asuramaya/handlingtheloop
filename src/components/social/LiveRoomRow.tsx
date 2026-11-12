import { REASON_LABEL, type Reason } from "@htl/account";
import type { LiveRoom } from "@htl/account";
import { PersonCardRow, type PersonRel } from "./PersonCardRow";

// One live-room row, as a PersonCardRow: the host, the coloured tag for who they are to you, and
// what is playing with the listener count. Tap it for the strip: Listen (or "Tuned in"), and
// Profile ›. Your own room has no Listen; its strip offers your profile.
export function LiveRoomRow({
  room: r,
  self,
  tunedTo,
  onListen,
  onOpen,
  reason,
}: {
  room: LiveRoom;
  self: string | null;
  tunedTo: string | null;
  onListen: (handle: string) => void;
  onOpen: (handle: string) => void;
  // WHY this row is where it is. One ranked list only reads as ranked if each row can say what
  // put it there; without this the order is invisible and the list looks arbitrary.
  reason?: Reason;
}) {
  const mine = r.handle === self;
  const rel: PersonRel = mine ? "you" : r.rel === 2 ? "friend" : r.rel === 1 ? "following" : "other";
  const np = r.npTitle ? `${r.npArtist ? `${r.npArtist} · ` : ""}${r.npTitle}` : r.title || "on air";
  // The relation tag already says Friend / Following; only the reasons it cannot say get a badge.
  const why = reason === "fresh" || reason === "popular" ? REASON_LABEL[reason] : null;
  return (
    <PersonCardRow
      name={r.displayName || `@${r.handle}`}
      avatar={r.avatar}
      rel={rel}
      presence="live"
      badge={
        <>
          {why && <span className={`room-badge why ${reason}`}>{why}</span>}
          {r.handle === tunedTo && <span className="room-badge clock">tuned in</span>}
        </>
      }
      meta={`${np} · ${r.listeners} 🎧`}
      actions={
        mine ? null : r.handle === tunedTo ? (
          <span className="peer-pill static on">🎧 Listening</span>
        ) : (
          <button className="peer-pill on" onClick={() => onListen(r.handle)}>
            🎧 Listen
          </button>
        )
      }
      onProfile={() => onOpen(r.handle)}
    />
  );
}
