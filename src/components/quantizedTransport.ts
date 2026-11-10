import type { Deck, DeckId } from "@htl";
import type { Intent } from "@htl/room/protocol";

// The user's play / CUE / hot cue, QUANTIZED when the deck's grid lock is on (Deck.quantized,
// quantize.ts). One definition shared by every surface that has these buttons (keyboard, the board,
// the on-screen deck), so a start lands in step whichever one you used. The intent is emitted when
// the action actually happens, not when the button was pressed.

type Emit = (i: Intent) => void;

/** Play / pause. A start waits for its moment; pressing again while it waits calls it off. */
export function quantizedTogglePlay(deck: Deck, id: DeckId, emit: Emit, after?: () => void): void {
  if (deck.quantizePending) {
    deck.cancelQuantized();
    after?.();
    return;
  }
  if (deck.playing) {
    deck.togglePlay();
    emit({ kind: "transport", deck: id, action: deck.playing ? "play" : "pause" });
    after?.();
    return;
  }
  deck.quantized(deck.position(), (pos) => {
    if (Math.abs(pos - deck.position()) > 1e-4) deck.seek(pos);
    deck.togglePlay();
    emit({ kind: "transport", deck: id, action: deck.playing ? "play" : "pause" });
    after?.();
  });
}

/** Start a paused deck from where it sits (a pad launch), in step. */
export function quantizedPlay(deck: Deck, id: DeckId, emit: Emit, after?: () => void): void {
  deck.quantized(deck.position(), (pos) => {
    if (Math.abs(pos - deck.position()) > 1e-4) deck.seek(pos);
    deck.play();
    emit({ kind: "transport", deck: id, action: "play" });
    after?.();
  });
}

/** CUE while playing: back to the cue point, in step. */
export function quantizedJumpToCue(deck: Deck, id: DeckId, emit: Emit, after?: () => void): void {
  deck.quantized(deck.cuePoint, (pos) => {
    deck.seek(pos);
    emit({ kind: "transport", deck: id, action: "seek", position: deck.position() });
    after?.();
  });
}

/** A hot cue press. Jumping to a SET cue while playing is quantized; setting a cue, a saved loop,
 *  or a paused deck (which only moves the needle) act at once. */
export function quantizedHotCue(deck: Deck, id: DeckId, slot: number, emit: Emit, after?: () => void): void {
  const t = deck.hotCues[slot];
  if (deck.playing && t != null && !deck.hotLoops[slot]) {
    deck.quantized(t, (pos) => {
      deck.seek(pos);
      emit({ kind: "hotcue", deck: id, slot, action: "press" });
      after?.();
    });
    return;
  }
  deck.hotCue(slot);
  emit({ kind: "hotcue", deck: id, slot, action: "press" });
  after?.();
}
