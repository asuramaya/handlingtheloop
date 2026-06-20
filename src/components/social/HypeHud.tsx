import type { RoomState } from "@htl/room";

// F2 — the live crowd-energy meter on the BOARD HUD (the chin), not just inside the Session
// panel. Whenever a broadcast is happening (you host one, or you've tuned in) the DJ reads the
// hype bar without opening anything; it throbs when hot. Tap → open the crowd channel (Session).
export function HypeHud({ room, onOpen }: { room: RoomState; onOpen?: () => void }) {
  if (!room.roomPublic && !room.listeningTo) return null;
  const pct = Math.round(room.hype * 100);
  return (
    <button
      className={`hype-hud ${pct >= 70 ? "hot" : ""}`}
      onClick={onOpen}
      title={`Crowd energy ${pct}%${room.roomPublic ? ` · ${room.listenerCount} listening` : ""} — open the crowd channel`}
      aria-label={`Crowd energy ${pct}%`}
    >
      <span className="hype-hud-icon" aria-hidden="true">🔥</span>
      <span className="hype-hud-bar">
        <span className="hype-hud-fill" style={{ width: `${pct}%` }} />
      </span>
    </button>
  );
}
