import { useLayoutEffect, useRef, useState } from "react";

// ANCHORING — a section head that sticks to the top of the scroll and says WHERE IN THE LIST you
// are while the rows pass under it.
//
// ★ WHY A COUNT AND NOT JUST A STICKY LABEL. A pinned "Following" tells you which list you are
// in, which you already knew. What makes a long column stop feeling endless is knowing your
// POSITION in it — "87–150 of 2000" is a place; an unlabelled scroll is not. This is the half of
// the "infinite list" complaint that state memory cannot fix: memory gets you back to where you
// were, and this tells you where that is.
//
// Position is derived from scrollTop against a measured row height rather than from
// IntersectionObserver on every row: one number per frame instead of N observers, and the rows
// here are uniform by construction (PersonRow / LiveRoomRow are fixed-height).
export function StickyRange({
  label,
  total,
  loaded,
  listRef,
  hasMore = false,
  extra,
}: {
  label: string;
  /** Everything there is, if known — the "of N". */
  total?: number;
  /** How many rows are actually rendered right now. */
  loaded: number;
  listRef: React.RefObject<HTMLElement | null>;
  /** More pages exist beyond what is loaded — rendered as a "+" on the total. */
  hasMore?: boolean;
  extra?: React.ReactNode;
}) {
  const [range, setRange] = useState<[number, number] | null>(null);
  const selfRef = useRef<HTMLDivElement | null>(null);
  const raf = useRef(0);

  // ★ FIND THE SCROLLER FROM OUR OWN NODE, not from a ref handed down by the parent. The first
  // version took a `scrollRef` that the parent populated in an effect — and child effects run
  // BEFORE parent effects, so on mount the ref was still null, this bailed early, and the
  // listener was never attached: the range froze at whatever it read on the first paint and
  // never moved again. Nothing about that is visible in a diff; it just silently does nothing.
  // A LAYOUT effect, because we need the DOM position, and closest() needs us mounted.
  useLayoutEffect(() => {
    const scroller = selfRef.current?.closest<HTMLElement>(".settings-body") ?? null;
    const list = listRef.current;
    if (!scroller || !list || loaded === 0) {
      setRange(null);
      return;
    }
    const measure = () => {
      raf.current = 0;
      const rows = list.children.length;
      if (!rows) return setRange(null);
      const rowH = list.getBoundingClientRect().height / rows;
      if (!rowH || !Number.isFinite(rowH)) return setRange(null);
      // Where the list sits inside the scroller, in scroll coordinates.
      const listTop = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      const first = Math.floor((scroller.scrollTop - listTop) / rowH);
      const visible = Math.ceil(scroller.clientHeight / rowH);
      const lo = Math.max(1, Math.min(rows, first + 1));
      const hi = Math.max(lo, Math.min(rows, first + visible));
      setRange([lo, hi]);
    };
    const onScroll = () => {
      if (raf.current) return;
      raf.current = requestAnimationFrame(measure);
    };
    measure();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [listRef, loaded]);

  return (
    <div className="social-section-head sticky-range" ref={selfRef}>
      <span className="sticky-range-label">{label}</span>
      {loaded > 0 && (
        <span className="friends-count">
          {/* The range only earns its place once there is more than a screenful; below that it
              would report "1–8 of 8", which is noise dressed as information. The "+" carries
              "there are more pages" INSIDE the total — a separate "loaded 250+" beside "of 250"
              said the same number twice and read as two different facts. */}
          {range && range[1] < loaded ? `· ${range[0]}–${range[1]} of ` : "· "}
          {total ?? loaded}
          {hasMore ? "+" : ""}
        </span>
      )}
      {extra}
    </div>
  );
}
