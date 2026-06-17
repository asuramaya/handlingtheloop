import type { RoomState } from "@htl/room";
import { maskName } from "@htl/privacy";

// The crowd-ranked song-request list (F1 + F3). Everyone can upvote (▲, one per device); the
// list is server-sorted most-wanted first. The host variant also shows who asked + dismiss +
// clear; the crowd variant is just ▲ + the track, so listeners vote the setlist without the
// roster noise.
export function RequestList({ room, host, revealed }: { room: RoomState; host: boolean; revealed: boolean }) {
  if (room.songRequests.length === 0) return null;
  return (
    <div className={`req-list ${host ? "host" : "crowd"}`}>
      <div className="social-section-head req-head">
        🎵 Requests
        {host && (
          <button className="req-clear" onClick={room.clearRequests}>
            Clear all
          </button>
        )}
      </div>
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
