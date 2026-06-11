import { useLayoutEffect, useRef, useState } from "react";

const PAD = 1; // knob track sits on the border (outer stroke edge aligns with the box edge)
const DOT_R = 4; // marker radius

// The knob path is the FULL border (a closed rounded-rect), traced from the
// bottom-centre COUNTER-CLOCKWISE (bottom · left · top · right · back to bottom).
// min→max maps along that loop, so the midpoint (0 on a bipolar control) lands at
// the top-centre, negatives on the left, positives on the right. Returns the path
// `d`, its length, and an analytic point-at-distance helper consistent with it.
function knobGeom(w: number, h: number) {
  const x0 = PAD, y0 = PAD, x1 = w - PAD, y1 = h - PAD;
  const r = Math.max(0, Math.min(8, (x1 - x0) / 2, (y1 - y0) / 2));
  const cx = (x0 + x1) / 2;
  const d =
    `M ${cx} ${y1} L ${x0 + r} ${y1} A ${r} ${r} 0 0 1 ${x0} ${y1 - r} ` +
    `L ${x0} ${y0 + r} A ${r} ${r} 0 0 1 ${x0 + r} ${y0} ` +
    `L ${x1 - r} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y0 + r} ` +
    `L ${x1} ${y1 - r} A ${r} ${r} 0 0 1 ${x1 - r} ${y1} Z`;
  const bl = cx - x0 - r;
  const br = x1 - r - cx;
  const side = y1 - y0 - 2 * r;
  const top = x1 - x0 - 2 * r;
  const arc = (Math.PI / 2) * r;
  const len = bl + arc + side + arc + top + arc + side + arc + br;
  const at = (dist: number): [number, number] => {
    let s = Math.max(0, Math.min(len, dist));
    if (s <= bl) return [cx - s, y1];
    s -= bl;
    if (s <= arc) { const a = s / r; return [x0 + r - r * Math.sin(a), y1 - r + r * Math.cos(a)]; }
    s -= arc;
    if (s <= side) return [x0, y1 - r - s];
    s -= side;
    if (s <= arc) { const a = s / r; return [x0 + r - r * Math.cos(a), y0 + r - r * Math.sin(a)]; }
    s -= arc;
    if (s <= top) return [x0 + r + s, y0];
    s -= top;
    if (s <= arc) { const a = s / r; return [x1 - r + r * Math.sin(a), y0 + r - r * Math.cos(a)]; }
    s -= arc;
    if (s <= side) return [x1, y0 + r + s];
    s -= side;
    if (s <= arc) { const a = s / r; return [x1 - r + r * Math.cos(a), y1 - r + r * Math.sin(a)]; }
    s -= arc;
    return [x1 - r - s, y1];
  };
  return { d, len, at };
}

interface KnobBorderProps {
  value: number;
  min: number;
  max: number;
  pivot?: number; // bipolar pivot — pins to the top-centre; omit for a unipolar control
}

// The knob-style level indicator: an accent trace around the full border charging
// to the current value, capped by a circle DOT riding on the outer edge. Drop it
// into any position:relative box (a cell OR a button); it measures itself so the
// path is drawn in real px (no distortion).
export function KnobBorder({ value, min, max, pivot }: KnobBorderProps) {
  const ref = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setSize({ w: node.clientWidth, h: node.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const bipolar = pivot != null;
  const span = max - min || 1;
  let valuePos: number;
  if (bipolar) {
    const pv = pivot as number;
    valuePos = value <= pv ? (pv > min ? 0.5 * (value - min) / (pv - min) : 0) : (max > pv ? 0.5 + 0.5 * (value - pv) / (max - pv) : 1);
  } else {
    valuePos = (value - min) / span;
  }
  valuePos = Math.max(0, Math.min(1, valuePos));
  const anchor = bipolar ? 0.5 : 0;
  const lo = Math.min(anchor, valuePos);
  const hi = Math.max(anchor, valuePos);
  const geom = size.w > 0 && size.h > 0 ? knobGeom(size.w, size.h) : null;
  const dot = geom ? geom.at(valuePos * geom.len) : null;
  const fillStyle = geom ? { strokeDasharray: `${(hi - lo) * geom.len} ${geom.len + 1}`, strokeDashoffset: `${-lo * geom.len}` } : undefined;

  return (
    <svg ref={ref} className="vcell-knob" viewBox={geom ? `0 0 ${size.w} ${size.h}` : undefined} preserveAspectRatio="none" aria-hidden="true">
      {geom && (
        <>
          <path className="vcell-knob-track" d={geom.d} vectorEffect="non-scaling-stroke" />
          <path className="vcell-knob-fill" d={geom.d} vectorEffect="non-scaling-stroke" style={fillStyle} />
          {dot && <circle className="vcell-knob-dot" cx={dot[0]} cy={dot[1]} r={DOT_R} />}
        </>
      )}
    </svg>
  );
}
