import type { RoomState } from "@htl/room";
import { maskName } from "@htl/privacy";

// The crowd-ranked song-request list (F1 + F3). Everyone can upvote (▲, one per device); the
// list is server-sorted most-wanted first. The host variant also shows who asked + dismiss +
// clear; the crowd variant is just ▲ + the track, so listeners vote the setlist without the
// roster noise.
export function RequestList({
  room,
  host,
  revealed,
  onQueue,
}: {
  room: RoomState;
  host: boolean;
  revealed: boolean;
  onQueue?: (text: string, reqId: string) => void; // F1→queue: one-tap action onto the auto-mix queue
}) {
  const empty = room.songRequests.length === 0;
  // For a listener, nothing to show until requests exist. For a live HOST, show the section even
  // when empty so they KNOW the crowd can suggest songs + where those land (the discoverability gap).
  if (empty && !(host && room.roomPublic)) return null;
  return (
    <div className={`req-list ${host ? "host" : "crowd"}`}>
      <div className="social-section-head req-head">
        🎵 Song requests
        {host && !empty && (
          <button className="req-clear" onClick={room.clearRequests}>
            Clear all
          </button>
        )}
      </div>
      {empty && <div className="req-empty">Listeners can suggest songs — they show up here, crowd-ranked. Tap <b>＋ Queue</b> to drop one into your auto-mix queue.</div>}
      {room.songRequests.map((r) => {
        const voted = room.votedRequests.has(r.id);
        return (
          <div key={r.id} className="req-row">
            <button
              className={`req-vote ${voted ? "on" : ""}`}
              onClick={() => room.voteRequest(r.id)}
              disabled={voted}
              title={voted ? "Voted" : "Upvote"}
              aria-label={`Upvote (${r.votes})`}
            >
              <span className="req-caret" aria-hidden="true">▲</span>
              <span className="req-votes">{r.votes}</span>
            </button>
            <span className="req-text">{r.text}</span>
            {host && <span className="req-who">{revealed ? r.name : maskName(r.name)}</span>}
            {host && onQueue && (
              <button className="req-queue" onClick={() => onQueue(r.text, r.id)} title="Find it + add to the queue" aria-label="Add to queue">
                ＋ Queue
              </button>
            )}
            {host && (
              <button className="req-dismiss" onClick={() => room.dismissRequest(r.id)} title="Dismiss" aria-label="Dismiss request">
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
