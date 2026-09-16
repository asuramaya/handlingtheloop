// Did the engine just lose a stem set it was supposed to be holding?
//
// ★ THE FAILURE. Stems can be APPLIED before a deck's playback node exists: the AudioEngine starts
// loading worklets asynchronously at construction, the stem pipeline does not wait for it, and a
// failed attach retries on the next gesture — so a refresh with stems in IndexedDB can land them
// first. With no node, loadEnginePcm returns early and the engine receives nothing. But the deck
// then behaves as if it had: the float32 set is released ("the stretch engine already holds its own
// copy"), and on mobile the mix buffer is released too ("stems are the worklet's audio source now").
// Both comments are false exactly when no node was attached. The first attach then finds no stems —
// and, on mobile, no mix — while `stemsLoaded` still says true and the stem controls stay lit.
//
// This predicate is evaluated at the moment the engine is about to be (re)loaded. It is TRUE when a
// node is present, the load is NOT a stem load (there is no local set to send), the deck believes
// stems are loaded, and it is not a remote mirror (a mirror marks stems loaded with no local set,
// by design). In that state whatever the engine held is about to be replaced by the mix, so the set
// is gone — the deck must stop claiming it and ask for it again.

export interface EngineLoadState {
  nodeAttached: boolean;
  loadingStems: boolean;
  stemsLoaded: boolean;
  remote: boolean;
}

export function stemsLostOnLoad(s: EngineLoadState): boolean {
  return s.nodeAttached && !s.loadingStems && s.stemsLoaded && !s.remote;
}
