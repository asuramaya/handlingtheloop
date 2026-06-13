import type { RoomState } from "@htl/room";

// Chin entry to the shared DJ session. A single tap opens the full social screen
// (SocialScreen) — there's no separate mini popover anymore, so the session lives in ONE
// menu. The button itself is the at-a-glance read: a status dot + a count / knock badge.
export function RoomBar({ room, onExpand }: { room: RoomState; onExpand?: () => void }) {
  const online = room.status === "online";
  const inSession = room.signedIn || room.isGuest;
  const others = room.peers.filter((p) => p.id !== room.you);
  const knocks = room.host ? room.peers.filter((p) => p.pending) : []; // guests waiting on the handshake

  const dot = !inSession
    ? "idle"
    : !online
      ? room.status === "error"
        ? "error"
        : "connecting"
      : room.joined
        ? "online"
        : "idle";

  return (
    <div className="room">
      <button
        className="chin-btn chin-room"
        onClick={() => onExpand?.()}
        aria-label="Shared session and devices"
        title="Shared DJ session"
      >
        <span className={`chin-room-i ${dot}`} aria-hidden="true">⇅</span>
        {knocks.length > 0 ? (
          <span className="room-count knock">{knocks.length}</span>
        ) : (
          others.length > 0 && <span className="room-count">{others.length}</span>
        )}
      </button>
    </div>
  );
}
