import { useEffect, useRef, useState, type RefObject } from "react";
import {
  TOUCHDRAG_START_EVT,
  TOUCHDRAG_MOVE_EVT,
  TOUCHDRAG_END_EVT,
  TOUCHDRAG_CANCEL_EVT,
} from "../../htl/state/touchDrag";
import { TRACK_DND_MIME } from "./trackTable";

// True only once a TRACK drag has moved PAST the given element's own bounds — not the moment
// any drag starts. The first version of this (useAnyDragActive) went true at dragstart
// regardless of position, which broke dropping a track onto a PLAYLIST inside the Library
// panel itself in "center" mode: Library would vanish the instant you picked up a row, before
// the drag ever reached the playlist target it was headed for, because that target was part
// of the very panel that just hid itself. Tracking position instead means an entirely
// internal drag (Collection → a playlist, reordering a playlist) never leaves the element's
// bounds and so never triggers anything; only a drag that's actually headed OUT — toward a
// deck underneath — does.
//
// One shared state object (not two independent booleans toggled by two independent listener
// sets) so the native-mouse and touch-bus paths can't stomp each other mid-gesture — only
// one of the two is ever actually live on a given device (no mobile browser fires real HTML5
// drag events from touch), but a single source of truth removes the possibility outright
// rather than relying on that being true.
export function useDragOutside(ref: RefObject<HTMLElement | null>): boolean {
  const [outside, setOutside] = useState(false);
  const liveRef = useRef<"native" | "touch" | null>(null);

  useEffect(() => {
    const isOutside = (x: number, y: number): boolean => {
      const el = ref.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return x < r.left || x > r.right || y < r.top || y > r.bottom;
    };

    const onNativeStart = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes(TRACK_DND_MIME)) return;
      liveRef.current = "native";
      setOutside(false); // always begins inside — you grab a row FROM this panel
    };
    const onNativeOver = (e: DragEvent) => {
      if (liveRef.current !== "native") return;
      setOutside(isOutside(e.clientX, e.clientY));
    };
    const onNativeEnd = () => {
      if (liveRef.current !== "native") return;
      liveRef.current = null;
      setOutside(false);
    };

    const onTouchStart = (e: Event) => {
      liveRef.current = "touch";
      const { x, y } = (e as CustomEvent<{ x: number; y: number }>).detail;
      setOutside(isOutside(x, y));
    };
    const onTouchMove = (e: Event) => {
      if (liveRef.current !== "touch") return;
      const { x, y } = (e as CustomEvent<{ x: number; y: number }>).detail;
      setOutside(isOutside(x, y));
    };
    const onTouchEnd = () => {
      if (liveRef.current !== "touch") return;
      liveRef.current = null;
      setOutside(false);
    };

    document.addEventListener("dragstart", onNativeStart);
    document.addEventListener("dragover", onNativeOver);
    document.addEventListener("dragend", onNativeEnd);
    document.addEventListener("drop", onNativeEnd);
    document.addEventListener(TOUCHDRAG_START_EVT, onTouchStart);
    document.addEventListener(TOUCHDRAG_MOVE_EVT, onTouchMove);
    document.addEventListener(TOUCHDRAG_END_EVT, onTouchEnd);
    document.addEventListener(TOUCHDRAG_CANCEL_EVT, onTouchEnd);
    return () => {
      document.removeEventListener("dragstart", onNativeStart);
      document.removeEventListener("dragover", onNativeOver);
      document.removeEventListener("dragend", onNativeEnd);
      document.removeEventListener("drop", onNativeEnd);
      document.removeEventListener(TOUCHDRAG_START_EVT, onTouchStart);
      document.removeEventListener(TOUCHDRAG_MOVE_EVT, onTouchMove);
      document.removeEventListener(TOUCHDRAG_END_EVT, onTouchEnd);
      document.removeEventListener(TOUCHDRAG_CANCEL_EVT, onTouchEnd);
    };
  }, [ref]);

  return outside;
}
