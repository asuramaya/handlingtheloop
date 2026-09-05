import { useEffect, type RefObject } from "react";
import type { TrackMeta } from "@htl/library";

// Touch drag-and-drop — the HTML5 `draggable`/`dataTransfer` protocol every mouse drag in this
// app already rides (TrackTable rows → DeckLane / SongOverview / playlists) has NO touch
// equivalent in ANY mobile browser; a `draggable` element is simply inert on a touchscreen. This
// is the missing half: a small, self-contained event bus (custom DOM events on `document`, so
// source and destination never need to know about each other directly — same decoupling the
// native drag/drop events already give the mouse path) plus a vanilla-DOM ghost preview that
// follows the finger. Deliberately NOT a React component mounted from App.tsx: the ghost element
// is created/destroyed directly via DOM APIs from here, so wiring this in touches only the
// source (TrackTable's row) and destination (SongOverview) — never the large, currently-
// entangled shared files (App.tsx, DeckLane.tsx) a React-mounted ghost would need a home in.
//
// Protocol: startTouchDrag → any number of moveTouchDrag → exactly one of endTouchDrag (a real
// drop attempt — destinations hit-test themselves) or cancelTouchDrag (aborted, no drop).

export interface TouchDragPayload {
  tracks: TrackMeta[];
  label: string; // ghost preview text
  thumbnail?: string | null;
}

interface TouchDragDetail {
  payload: TouchDragPayload;
  x: number;
  y: number;
}

// Exported so components outside this module (e.g. a "something's being dragged right now"
// hook that also needs the native HTML5 drag events, which don't belong in this file) can
// subscribe without duplicating the event-name strings.
export const TOUCHDRAG_START_EVT = "htl:touchdrag-start";
export const TOUCHDRAG_MOVE_EVT = "htl:touchdrag-move";
export const TOUCHDRAG_END_EVT = "htl:touchdrag-end";
export const TOUCHDRAG_CANCEL_EVT = "htl:touchdrag-cancel";
const START_EVT = TOUCHDRAG_START_EVT;
const MOVE_EVT = TOUCHDRAG_MOVE_EVT;
const END_EVT = TOUCHDRAG_END_EVT;
const CANCEL_EVT = TOUCHDRAG_CANCEL_EVT;

let ghost: HTMLDivElement | null = null;
let active = false;

function ensureGhost(): HTMLDivElement {
  if (ghost) return ghost;
  const el = document.createElement("div");
  el.style.cssText = [
    "position:fixed",
    "z-index:99999",
    "pointer-events:none",
    "display:flex",
    "align-items:center",
    "gap:8px",
    "padding:6px 12px 6px 6px",
    "border-radius:10px",
    "background:rgba(10,12,16,0.92)",
    "border:1px solid rgba(255,255,255,0.18)",
    "box-shadow:0 6px 20px rgba(0,0,0,0.45)",
    "color:#fff",
    "font:600 12px ui-monospace, monospace",
    "max-width:220px",
    "white-space:nowrap",
    "overflow:hidden",
    "text-overflow:ellipsis",
    "transform:translate(-50%,-130%)",
    "opacity:0",
    "transition:opacity 0.08s ease",
  ].join(";");
  document.body.appendChild(el);
  ghost = el;
  return el;
}

function paintGhost(payload: TouchDragPayload, x: number, y: number) {
  const el = ensureGhost();
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.opacity = "1";
  const thumb = payload.thumbnail ? `<img src="${payload.thumbnail}" style="width:24px;height:24px;border-radius:5px;object-fit:cover;flex:0 0 auto" />` : "";
  el.innerHTML = `${thumb}<span style="overflow:hidden;text-overflow:ellipsis">${payload.label}</span>`;
}

function removeGhost() {
  if (ghost) {
    ghost.remove();
    ghost = null;
  }
}

export function isTouchDragging(): boolean {
  return active;
}

export function startTouchDrag(payload: TouchDragPayload, x: number, y: number): void {
  active = true;
  paintGhost(payload, x, y);
  document.dispatchEvent(new CustomEvent<TouchDragDetail>(START_EVT, { detail: { payload, x, y } }));
}

export function moveTouchDrag(payload: TouchDragPayload, x: number, y: number): void {
  if (!active) return;
  paintGhost(payload, x, y);
  document.dispatchEvent(new CustomEvent<TouchDragDetail>(MOVE_EVT, { detail: { payload, x, y } }));
}

export function endTouchDrag(payload: TouchDragPayload, x: number, y: number): void {
  if (!active) return;
  active = false;
  removeGhost();
  document.dispatchEvent(new CustomEvent<TouchDragDetail>(END_EVT, { detail: { payload, x, y } }));
}

export function cancelTouchDrag(): void {
  if (!active) return;
  active = false;
  removeGhost();
  document.dispatchEvent(new Event(CANCEL_EVT));
}

/** Drop-target side: point a ref at the element that should accept a touch drag, get live
 *  hover feedback (`onOver`) as the ghost passes over/off it, and `onDrop` when a drag ends
 *  while it's inside the element's bounds. Mirrors the shape of the native
 *  onDragOver/onDragLeave/onDrop trio the mouse path already uses on the same elements, so a
 *  component can wire both with the same mental model. */
export function useTouchDropTarget(ref: RefObject<HTMLElement | null>, onDrop: (tracks: TrackMeta[]) => void, onOver?: (over: boolean) => void): void {
  useEffect(() => {
    const inside = (x: number, y: number): boolean => {
      const el = ref.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    const onMove = (e: Event) => {
      const { x, y } = (e as CustomEvent<TouchDragDetail>).detail;
      onOver?.(inside(x, y));
    };
    const onEnd = (e: Event) => {
      const { payload, x, y } = (e as CustomEvent<TouchDragDetail>).detail;
      onOver?.(false);
      if (inside(x, y) && payload.tracks.length) onDrop(payload.tracks);
    };
    const onCancel = () => onOver?.(false);
    document.addEventListener(START_EVT, onMove);
    document.addEventListener(MOVE_EVT, onMove);
    document.addEventListener(END_EVT, onEnd);
    document.addEventListener(CANCEL_EVT, onCancel);
    return () => {
      document.removeEventListener(START_EVT, onMove);
      document.removeEventListener(MOVE_EVT, onMove);
      document.removeEventListener(END_EVT, onEnd);
      document.removeEventListener(CANCEL_EVT, onCancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onDrop, onOver]);
}
