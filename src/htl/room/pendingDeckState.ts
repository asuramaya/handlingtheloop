// LOOP / CUE STATE THAT ARRIVES BEFORE ITS TRACK DOES.
//
// ★ (operator, 2026-11-11: session sync audit) A loop, cue or hot-cue intent that reached a device
// whose deck still held ANOTHER track (a load mid-flight, or a deck the tick says is on the wrong
// song) was applied to the old buffer, and then LoopEngine.reset() wiped it the moment the session's
// buffer landed (Deck.setBuffer). The DJ's loop simply never existed on that device.
//
// Since those intents now carry absolute RESULTS (loopWire.ts), they can be held: keyed to the
// videoId they were meant for, collapsed to the latest per target (the loop state, the cue point,
// each hot-cue slot), and applied once that track is on the deck. A head move they carried is
// dropped on replay: by then the tick follower owns the playhead, and a seconds-old position would
// only yank it back.
//
// Pure (no React, no engine) so the decisions are tested here; useSessionSync holds one instance
// per session and does the two-line hook-up (stash on arrival, drain when `loaded` changes).

import type { DeckId, Intent } from "./protocol";
import { holdsForeignTrack, type DeckIdentityInput } from "./sessionFollow";

type DeckIntent = Extract<Intent, { deck: DeckId }>;

/** The collapse key of an intent that carries absolute loop / cue state, or null for anything else
 *  (including an older peer's result-less loop or hot-cue press, which means nothing on a track
 *  this device does not have yet). */
export function deckStateKey(i: Intent): string | null {
  if (i.kind === "loop") return i.state !== undefined ? "loop" : null;
  if (i.kind === "loopBounds") return "loop";
  if (i.kind === "cue") return "cue";
  if (i.kind === "hotcue") {
    if (i.action === "clear") return `hc${i.slot}`;
    return i.cue !== undefined || i.loop !== undefined ? `hc${i.slot}` : null;
  }
  return null;
}

/** Which track an arriving state intent is FOR when this deck does not hold it, or null when the
 *  deck holds the session's track (apply now). The room's load target wins; else the anchor's tick. */
export function pendingTarget(p: DeckIdentityInput): string | null {
  if (!holdsForeignTrack(p)) return null;
  return p.roomLoadTarget ?? p.tickVid ?? null;
}

/** The intent as it should be replayed once its track has landed: without a head move. */
export function forReplay(i: DeckIntent): DeckIntent {
  if ((i.kind === "loop" || i.kind === "loopBounds" || i.kind === "hotcue") && i.position != null) {
    const { position: _drop, ...rest } = i;
    return rest as DeckIntent;
  }
  return i;
}

export class PendingDeckState {
  private held: Partial<Record<DeckId, { videoId: string; byKey: Map<string, DeckIntent> }>> = {};

  /** Hold `intent` for `videoId` on its deck. Returns false (not held) when it is not a state
   *  intent. A different videoId replaces whatever was held for the old target. */
  stash(videoId: string, intent: DeckIntent): boolean {
    const key = deckStateKey(intent);
    if (!key) return false;
    let h = this.held[intent.deck];
    if (!h || h.videoId !== videoId) h = this.held[intent.deck] = { videoId, byKey: new Map() };
    h.byKey.delete(key); // re-insert so the map's order is the order of the LATEST arrivals
    h.byKey.set(key, forReplay(intent));
    return true;
  }

  /** The held intents for `deck` IF its loaded track is the one they were for (then forgotten), in
   *  arrival order. Anything held for another track stays until that track lands or is replaced. */
  take(deck: DeckId, loadedId: string | null | undefined): DeckIntent[] {
    const h = this.held[deck];
    if (!h || !loadedId || h.videoId !== loadedId) return [];
    delete this.held[deck];
    return [...h.byKey.values()];
  }

  /** Forget everything (leaving the session). */
  clear(): void {
    this.held = {};
  }

  /** What is held for a deck (tests / debug). */
  peek(deck: DeckId): { videoId: string; intents: DeckIntent[] } | null {
    const h = this.held[deck];
    return h ? { videoId: h.videoId, intents: [...h.byKey.values()] } : null;
  }
}
