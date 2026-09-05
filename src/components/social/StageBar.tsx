import type { RoomState } from "@htl/room";

// LISTENER side of the floor→stage flow: raise a hand / grab a deck (depending on the host's
// gate), watch the request pend, then drive once you're up — or step back down. The host's
// gate mode (request/open/closed) decides what's offered. Only rendered while tuned in.
export function StageBar({ room }: { room: RoomState }) {
  if (room.onStage) {
    return (
      <div className="stage-bar up">
        <span className="stage-bar-what">
          🎛️ You're on the decks{room.myDeck ? <> · <b>Deck {room.myDeck}</b></> : null}
        </span>
        <button className="stage-down" onClick={room.stepDown}>
          Step down
        </button>
      </div>
    );
  }
  // The host has shut the decks to the crowd — nothing to offer.
  if (room.stageGate === "closed") {
    return (
      <div className="stage-bar closed">
        <span className="stage-bar-what">🔒 The host has closed the decks</span>
      </div>
    );
  }
  // A pending hand-raise (request mode; in open mode this only flashes before the grab resolves).
  if (room.myStageDeck) {
    return (
      <div className="stage-bar pending">
        <span className="stage-bar-what">✋ Requested <b>deck {room.myStageDeck}</b> — waiting for the host…</span>
        <button className="stage-down" onClick={room.stepDown}>
          Cancel
        </button>
      </div>
    );
  }
  // Open decks → grab one instantly; request decks → raise a hand for the host.
  const open = room.stageGate === "open";
  return (
    <div className="stage-bar">
      <span className="stage-bar-what">{open ? "🎛️ Open decks — grab one" : "✋ Request the decks"}</span>
      <span className="stage-bar-picks">
        <button className="stage-pick" onClick={() => room.requestStage("A")} title={open ? "Take deck A now" : "Ask to play deck A"}>
          {open ? "Take A" : "Deck A"}
        </button>
        <button className="stage-pick" onClick={() => room.requestStage("B")} title={open ? "Take deck B now" : "Ask to play deck B"}>
          {open ? "Take B" : "Deck B"}
        </button>
      </span>
    </div>
  );
}
