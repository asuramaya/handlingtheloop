import { createContext, useContext, useEffect, useState } from "react";

// ★ WHICH DECKS ARE RUNNING, FOR THE TRACK LISTS (operator, 2026-11-08: "make the current playing
// songs super obvious"). A list already knows which track sits on which deck (`deckLoaded`), but
// not whether that deck is PLAYING — and App deliberately does not re-render on transport (each
// lane animates itself), so a prop would go stale the moment a deck starts on its own (AUTO, a
// remote, the board). So the lists get a GETTER through context and poll it, a few times a
// second, only while something is loaded; state changes only when a deck actually flips.
export type DeckPlaying = { A: boolean; B: boolean };
export const DeckPlayingContext = createContext<(() => DeckPlaying) | null>(null);

const IDLE: DeckPlaying = { A: false, B: false };

export function useDeckPlaying(active: boolean): DeckPlaying {
  const get = useContext(DeckPlayingContext);
  const [state, setState] = useState<DeckPlaying>(IDLE);
  useEffect(() => {
    if (!get || !active) {
      setState((p) => (p.A || p.B ? IDLE : p));
      return;
    }
    const tick = () => {
      const v = get();
      setState((p) => (p.A === v.A && p.B === v.B ? p : { A: v.A, B: v.B }));
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [get, active]);
  return state;
}
