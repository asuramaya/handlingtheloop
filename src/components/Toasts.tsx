import { useEffect, useRef } from "react";

// A floating, bottom-centre notice stack. ★ THEY USED TO BE ABSOLUTELY POSITIONED INSIDE THE FADER
// ROW, which is a row exactly as tall as its contents — so a message longer than a few words got
// clipped mid-sentence and the rest of it lay across the decks. A notice you cannot finish reading
// is worse than no notice.
//
// Out of the board entirely: `position: fixed`, centred, capped, WRAPPING rather than truncating,
// and self-dismissing — a notice that needs a click to leave is a modal wearing a toast's clothes.
// A click still dismisses it early, because sometimes you have read it and want it gone.
export interface Toast {
  id: string;
  kind: "ok" | "warn";
  text: string;
}
const LIFE_MS: Record<Toast["kind"], number> = {
  ok: 2600, // "the take landed" — you either saw it or you did not care
  warn: 8000, // long enough to read twice, short enough not to become furniture
};

export function Toasts({ items, onDismiss }: { items: Toast[]; onDismiss: (id: string) => void }) {
  // One timer per live toast, keyed by id, so a new message does not restart an old one's clock.
  const timers = useRef<Map<string, number>>(new Map());
  const live = useRef(onDismiss);
  live.current = onDismiss;
  useEffect(() => {
    const ids = new Set(items.map((t) => t.id));
    for (const [id, tm] of timers.current) {
      if (!ids.has(id)) { clearTimeout(tm); timers.current.delete(id); }
    }
    for (const t of items) {
      if (timers.current.has(t.id)) continue;
      timers.current.set(t.id, window.setTimeout(() => { timers.current.delete(t.id); live.current(t.id); }, LIFE_MS[t.kind]));
    }
  }, [items]);
  useEffect(() => () => { for (const tm of timers.current.values()) clearTimeout(tm); }, []);

  if (!items.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <button key={t.id} className={`toast toast-${t.kind}`} onClick={() => onDismiss(t.id)}>
          <span className="toast-text">{t.text}</span>
          <span className="toast-x" aria-hidden="true">✕</span>
        </button>
      ))}
    </div>
  );
}
