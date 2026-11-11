import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

// ★ TEXT TOO LONG FOR ITS BOX SCROLLS ACROSS IT (operator, 2026-11-10: library titles and rows should
// do "what the song title does on the viewport where it scrolls"). The deck title's ticker, shared:
// fits → plain text; overflows → it glides to its end and back (the `lane-ticker` keyframes in
// board.css), at a speed set by how far it has to travel, pausing at each end.
export function Ticker({ children, className = "", title }: { children: ReactNode; className?: string; title?: string }) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [scroll, setScroll] = useState(0); // px the text overflows the box (0 = fits)
  useEffect(() => {
    const box = boxRef.current;
    const inner = innerRef.current;
    if (!box || !inner) return;
    const measure = () => {
      const over = inner.scrollWidth - box.clientWidth;
      setScroll(over > 6 ? over : 0);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [children]);
  const style = scroll > 0 ? ({ "--scroll": `${scroll}px`, "--ticker-dur": `${Math.max(5, scroll / 45 + 2).toFixed(1)}s` } as CSSProperties) : undefined;
  return (
    <span ref={boxRef} className={`ticker-box ${scroll > 0 ? "ticker" : ""} ${className}`} title={title}>
      <span ref={innerRef} className="ticker-inner" style={style}>
        {children}
      </span>
    </span>
  );
}
