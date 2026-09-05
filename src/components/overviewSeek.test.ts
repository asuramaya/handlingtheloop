import { describe, expect, it } from "vitest";
import { LABEL_BOX_PX, LABEL_MIN_LANE_PX, MARKER_SNAP_PX, MARKER_SNAP_TOUCH_PX, hitMarker, insetMark, laneAtX, laneRect, labelsShareColumn, loopIsCollapsed, markerLane, markerPriority, resolveLabels, overviewSeekTime, type OverviewMarker } from "./overviewSeek";

// The operator's own rail, from the DOM: 398 CSS px tall, a 3:35 track.
const GEOM = { top: 41, height: 398, duration: 215, left: 0, width: 128, side: "left" as const };
// The x of each lane's middle. On a LEFT rail, sections own the left half and markers the right.
const XS = 32; // sections lane
const XM = 96; // markers lane
// Phrase markers roughly every 8 bars at 124 BPM (~15.5s), plus a couple of cues — the density
// the rail actually carries.
const MARKERS: OverviewMarker[] = [0, 15.5, 31, 46.5, 62, 77.5, 93, 108.5, 124, 139.5, 155, 170.5, 186, 201.5].map(
  (t) => ({ t, kind: "phrase" as const }),
);

/** Walk the rail one CSS px at a time and report how the time advances. */
function sweep(snap: boolean) {
  const ts: number[] = [];
  for (let y = GEOM.top; y <= GEOM.top + GEOM.height; y += 1) ts.push(overviewSeekTime(XS, y, GEOM, MARKERS, snap));
  const steps = ts.slice(1).map((t, i) => t - ts[i]);
  const perPx = GEOM.duration / GEOM.height;
  return {
    ts,
    steps,
    /** Samples where the time did not move at all — the playhead stuck to a marker. */
    plateau: steps.filter((d) => Math.abs(d) < perPx * 0.05).length,
    /** The biggest single-pixel lurch, in units of "how far one pixel should move you". */
    worstLurch: Math.max(...steps.map((d) => Math.abs(d))) / perPx,
    monotonic: steps.every((d) => d >= -1e-9),
  };
}

describe("overview rail seek", () => {
  it("a press near a marker lands on that marker exactly", () => {
    const m = MARKERS[4].t; // 62s
    const y = GEOM.top + (m / GEOM.duration) * GEOM.height + (MARKER_SNAP_PX - 1);
    expect(overviewSeekTime(XS, y, GEOM, MARKERS, true)).toBeCloseTo(m, 6);
  });

  it("a press well clear of every marker is not pulled anywhere", () => {
    const y = GEOM.top + (8 / GEOM.duration) * GEOM.height; // 8s, mid-way between 0 and 15.5
    expect(overviewSeekTime(XS, y, GEOM, MARKERS, true)).toBeCloseTo(8, 6);
  });

  // ★ THE COMPLAINT, AS A TEST. A drag must map pixels to time linearly: every pixel moves you
  // the same amount, nothing sticks, nothing lurches.
  it("a DRAG is linear — no plateaus, no lurches", () => {
    const s = sweep(false);
    expect(s.plateau).toBe(0);
    expect(s.worstLurch).toBeLessThan(1.01);
    expect(s.monotonic).toBe(true);
  });

  // ★ AND A TEST THAT CAN FAIL. The assertion above is worth nothing unless the behaviour it
  // replaced would break it — so here is the old path (snapping on every pointermove), asserted
  // to be exactly as coarse as it felt.
  it("snapping during a drag is what made it coarse", () => {
    const s = sweep(true);
    expect(s.plateau).toBeGreaterThan(80); // ~14 markers × a ~13px-wide sticky zone
    expect(s.worstLurch).toBeGreaterThan(5); // leaving a zone lurches many pixels' worth at once
  });

  it("clamps at both ends of the rail", () => {
    expect(overviewSeekTime(XS, GEOM.top - 500, GEOM, MARKERS, false)).toBe(0);
    expect(overviewSeekTime(XS, GEOM.top + GEOM.height + 500, GEOM, MARKERS, false)).toBe(GEOM.duration);
  });

  it("is safe before a track has a duration", () => {
    expect(overviewSeekTime(XS, 100, { ...GEOM, top: 0, duration: 0 }, MARKERS, true)).toBe(0);
  });

  // ---- THE HIT-TEST, which the hover highlight and the snap BOTH ask -------------------------
  it("hover and click can never disagree — one function answers both", () => {
    for (let y = GEOM.top; y <= GEOM.top + GEOM.height; y += 0.5) {
      const i = hitMarker(XS, y, GEOM, MARKERS);
      const t = overviewSeekTime(XS, y, GEOM, MARKERS, true);
      if (i == null) expect(t).toBeCloseTo(overviewSeekTime(XS, y, GEOM, MARKERS, false), 9);
      else expect(t).toBeCloseTo(MARKERS[i].t, 9);
    }
  });

  it("returns nothing in open water", () => {
    const y = GEOM.top + (8 / GEOM.duration) * GEOM.height; // 8s, mid-way between 0 and 15.5
    expect(hitMarker(XS, y, GEOM, MARKERS)).toBeNull();
  });

  // ★ A MARKER YOU PLACED BEATS ONE THE APP DERIVED, at the same distance. Note the lane split
  // makes the phrase-vs-cue tie IMPOSSIBLE by construction now — they cannot share a column — so
  // the tie that remains is within the markers lane: a hot cue against the live loop's edge.
  it("breaks an exact tie toward the marker you placed yourself", () => {
    const both: OverviewMarker[] = [
      { t: 62, kind: "loop" },
      { t: 62, kind: "hot" },
    ];
    const y = GEOM.top + (62 / GEOM.duration) * GEOM.height;
    expect(both[hitMarker(XM, y, GEOM, both)!].kind).toBe("hot");
    // …and the answer must not depend on which order the draw loop pushed them in.
    expect(both.reverse()[hitMarker(XM, y, GEOM, both)!].kind).toBe("hot");
  });

  it("still prefers strictly nearer over higher priority", () => {
    const ms: OverviewMarker[] = [
      { t: 62, kind: "hot" },
      { t: 62.6, kind: "loop" },
    ];
    const y = GEOM.top + (62.6 / GEOM.duration) * GEOM.height;
    expect(ms[hitMarker(XM, y, GEOM, ms)!].kind).toBe("loop");
  });

  it("is deterministic for identical markers", () => {
    const ms: OverviewMarker[] = [
      { t: 62, kind: "hot" },
      { t: 62, kind: "hot" },
    ];
    const y = GEOM.top + (62 / GEOM.duration) * GEOM.height;
    expect(hitMarker(XM, y, GEOM, ms)).toBe(0); // first found, never draw-order-dependent
  });

  it("survives an empty rail", () => {
    expect(hitMarker(XS, 200, GEOM, [])).toBeNull();
    expect(overviewSeekTime(XS, 200, GEOM, [], true)).toBeCloseTo(railTimeOf(200), 6);
  });

  // ---- LANE SEPARATION ------------------------------------------------------------------------
  it("sections and markers never share a lane", () => {
    expect(markerLane("phrase")).toBe("sections");
    for (const k of ["loop", "cue", "hot"] as const) expect(markerLane(k)).toBe("markers");
  });
});

describe("the lane split is real, not decorative", () => {
  // ★ THE OPERATOR'S BUG: "when i try to click on the left side the a b c sections get triggered".
  // Two lanes that share one hit-test are one lane wearing a divider.
  const mixed: OverviewMarker[] = [
    { t: 62, kind: "phrase" }, // sections lane
    { t: 62, kind: "hot" }, // markers lane, same instant
  ];
  const yAt = (t: number) => GEOM.top + (t / GEOM.duration) * GEOM.height;

  it("a click in the sections half can only reach a section", () => {
    const i = hitMarker(XS, yAt(62), GEOM, mixed);
    expect(mixed[i!].kind).toBe("phrase");
  });

  it("a click in the markers half can only reach a marker", () => {
    const i = hitMarker(XM, yAt(62), GEOM, mixed);
    expect(mixed[i!].kind).toBe("hot");
  });

  it("a lane with nothing at that time snaps to nothing, it does not borrow the other", () => {
    const onlySections: OverviewMarker[] = [{ t: 62, kind: "phrase" }];
    expect(hitMarker(XS, yAt(62), GEOM, onlySections)).not.toBeNull();
    expect(hitMarker(XM, yAt(62), GEOM, onlySections)).toBeNull();
    // …and the seek then falls through to the raw time rather than jumping across the seam.
    expect(overviewSeekTime(XM, yAt(62), GEOM, onlySections, true)).toBeCloseTo(62, 6);
  });

  it("the halves swap with the rail's side, matching where each family is drawn", () => {
    const right = { ...GEOM, side: "right" as const };
    expect(laneAtX(XS, GEOM)).toBe("sections");
    expect(laneAtX(XM, GEOM)).toBe("markers");
    expect(laneAtX(XS, right)).toBe("markers");
    expect(laneAtX(XM, right)).toBe("sections");
    // The hit-test agrees with where laneRect actually paints the tick, on both sides.
    for (const g of [GEOM, right]) {
      for (const k of ["phrase", "hot", "cue", "loop", "sloop"] as const) {
        const paintedAtX = laneRect(k, g.side, g.width).x + g.width / 4; // middle of its own half
        expect(laneAtX(g.left + paintedAtX, g)).toBe(markerLane(k));
      }
    }
  });

  it("respects a rail that is not at x=0", () => {
    const offset = { ...GEOM, left: 1920 };
    expect(laneAtX(1920 + XS, offset)).toBe("sections");
    expect(laneAtX(1920 + XM, offset)).toBe("markers");
  });
});

describe("a short loop must not fight itself", () => {
  // ★ THE OPERATOR'S EDGE CASE: "a short loop fights itself start and end and it overlaps making
  // one of the tails unclickable". Two marks closer together than their own labels overprint into
  // a blob, and a nearest-wins snap gives the far edge a sliver of rail that can fall below a
  // pixel — so it is both unreadable AND unreachable.
  it("collapses once the two edges are closer than a label", () => {
    expect(loopIsCollapsed(100, 100)).toBe(true); // degenerate
    expect(loopIsCollapsed(100, 100 + LABEL_BOX_PX - 0.5)).toBe(true);
    expect(loopIsCollapsed(100, 100 + LABEL_BOX_PX)).toBe(false);
    expect(loopIsCollapsed(100, 140)).toBe(false); // a real region stays a region
  });

  it("does not care which edge is given first", () => {
    expect(loopIsCollapsed(140, 100)).toBe(false);
    expect(loopIsCollapsed(100 + LABEL_BOX_PX - 1, 100)).toBe(true);
  });

  // Collapsed, the loop registers ONE marker — so whatever the snap resolves to is the loop, and
  // there is no second edge holding a sub-pixel claim on the rail.
  it("leaves exactly one reachable target when collapsed", () => {
    const y0 = (30 / GEOM.duration) * GEOM.height + GEOM.top;
    const y1 = y0 + 2; // ~1 second at this scale: well inside a label
    expect(loopIsCollapsed(y0, y1)).toBe(true);
    const collapsed: OverviewMarker[] = [{ t: 30, kind: "loop" }];
    // Every pixel INSIDE the zone resolves to the one marker, never to nothing and never to a
    // rival. (The exact ±MARKER_SNAP_PX edge is a knife-edge float comparison — asserting it
    // would be testing rounding, not behaviour.)
    for (let d = -MARKER_SNAP_PX + 0.5; d <= MARKER_SNAP_PX - 0.5; d += 0.5) {
      expect(hitMarker(XM, y0 + d, GEOM, collapsed)).toBe(0);
    }
  });

  // The uncollapsed case is what the rule protects: two edges a label apart each own a usable
  // band of rail, so both are clickable.
  it("keeps both edges reachable once the loop is long enough to show as one", () => {
    const tIn = 30;
    const tOut = tIn + (LABEL_BOX_PX / GEOM.height) * GEOM.duration; // exactly the threshold
    const ms: OverviewMarker[] = [
      { t: tIn, kind: "loop" },
      { t: tOut, kind: "loop" },
    ];
    const yOf = (t: number) => GEOM.top + (t / GEOM.duration) * GEOM.height;
    expect(hitMarker(XM, yOf(tIn), GEOM, ms)).toBe(0);
    expect(hitMarker(XM, yOf(tOut), GEOM, ms)).toBe(1);
  });
});

describe("crowded labels", () => {
  const mk = (y: number, lane: "sections" | "markers", kind: Parameters<typeof markerPriority>[0], label = "X") => ({
    y,
    lane,
    priority: markerPriority(kind),
    label,
  });

  // ★ THE OPERATOR'S SCREENSHOT: a hot cue and a saved loop at almost the same instant rendered
  // as an unreadable "41". Ticks may touch; 13px glyph boxes may not.
  it("only one label survives when two crowd in the same lane", () => {
    const got = resolveLabels([mk(200, "markers", "hot", "4"), mk(202, "markers", "loop", "IN")]);
    expect(got).toEqual([true, false]); // the hand-placed cue keeps its identity
  });

  it("the SAME crowding in different lanes is not crowding at all", () => {
    const got = resolveLabels([mk(200, "markers", "hot", "4"), mk(202, "sections", "phrase", "B")]);
    expect(got).toEqual([true, true]);
  });

  it("leaves marks alone once they are a label apart", () => {
    const got = resolveLabels([mk(200, "markers", "hot", "4"), mk(200 + LABEL_BOX_PX, "markers", "hot", "5")]);
    expect(got).toEqual([true, true]);
  });

  it("is independent of the order the draw loop produced them in", () => {
    const a = mk(200, "markers", "hot", "4");
    const b = mk(202, "markers", "loop", "IN");
    expect(resolveLabels([a, b])).toEqual([true, false]);
    expect(resolveLabels([b, a])).toEqual([false, true]); // same winner, whichever came first
  });

  it("an unlabelled tick reserves nothing", () => {
    // A saved loop's bare OUT tick must never elbow a real label out of the lane.
    const got = resolveLabels([mk(200, "markers", "sloop", ""), mk(201, "markers", "hot", "4")]);
    expect(got).toEqual([false, true]);
  });

  it("a dense cluster keeps thinning out rather than stacking", () => {
    const cluster = [0, 3, 6, 9, 12, 15, 18].map((d) => mk(200 + d, "markers", "hot", String(d)));
    const got = resolveLabels(cluster);
    // Whatever survives must itself be non-overlapping — that is the whole contract.
    const ys = cluster.filter((_, i) => got[i]).map((m) => m.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(LABEL_BOX_PX);
    expect(ys.length).toBeGreaterThan(0); // never blanks the whole cluster
  });

  // ★ THE NARROW RAIL: labels share ONE column, so a section and a cue can now collide with each
  // other — which they could not while each lane had its own. The resolver must be told.
  it("sections and markers collide with each other once they share a column", () => {
    const pair = [mk(200, "sections", "phrase", "B"), mk(203, "markers", "hot", "4")];
    expect(resolveLabels(pair)).toEqual([true, true]); // wide rail: separate columns
    expect(resolveLabels(pair, true)).toEqual([false, true]); // narrow: the cue outranks
  });

  it("knows which widths can host a label per lane", () => {
    expect(labelsShareColumn(128)).toBe(false); // desktop
    expect(labelsShareColumn(64)).toBe(false); // base
    expect(labelsShareColumn(40)).toBe(true); // mobile — 20px lanes cannot hold a glyph
    expect(labelsShareColumn(32)).toBe(true); // the old mobile width
    expect(labelsShareColumn(LABEL_MIN_LANE_PX * 2)).toBe(false); // exactly enough
  });

  it("never drops a label that had the lane to itself", () => {
    const lone = [mk(50, "markers", "cue", "C"), mk(300, "sections", "phrase", "A")];
    expect(resolveLabels(lone)).toEqual([true, true]);
  });
});

describe("touch: no hover, and fat fingers", () => {
  const yOf = (g: typeof GEOM, t: number) => g.top + (t / g.duration) * g.height;

  // ★ A NARROW RAIL CANNOT ASK A FINGER TO PICK A 20px COLUMN. On the wide rail the lane split is
  // the operator's own requested precision; on the mobile rail it would make half the rack
  // unhittable, so the same width test that shares the label column frees the hit-test.
  const mixed: OverviewMarker[] = [
    { t: 62, kind: "phrase" },
    { t: 62, kind: "hot" },
  ];

  it("a wide rail keeps the lanes honest", () => {
    expect(mixed[hitMarker(XS, yOf(GEOM, 62), GEOM, mixed)!].kind).toBe("phrase");
    expect(mixed[hitMarker(XM, yOf(GEOM, 62), GEOM, mixed)!].kind).toBe("hot");
  });

  it("a narrow rail lets a touch anywhere reach either family", () => {
    const phone = { ...GEOM, width: 40 };
    // Both halves resolve to the same winner — nearest, then priority — instead of one half
    // being able to reach only sections and the other only markers.
    const left = hitMarker(phone.left + 8, yOf(phone, 62), phone, mixed);
    const right = hitMarker(phone.left + 32, yOf(phone, 62), phone, mixed);
    expect(left).toBe(right);
    expect(mixed[left!].kind).toBe("hot"); // the hand-placed one wins the tie
  });

  it("a nothing-there tap still snaps to nothing on a narrow rail", () => {
    const phone = { ...GEOM, width: 40 };
    expect(hitMarker(phone.left + 20, yOf(phone, 8), phone, mixed)).toBeNull();
  });

  it("a coarse pointer gets a bigger target", () => {
    const off = ((MARKER_SNAP_PX + MARKER_SNAP_TOUCH_PX) / 2 / GEOM.height) * GEOM.duration;
    const y = yOf(GEOM, 62 + off); // between the mouse radius and the touch radius
    const only: OverviewMarker[] = [{ t: 62, kind: "hot" }];
    expect(hitMarker(XM, y, GEOM, only)).toBeNull(); // a mouse misses
    expect(hitMarker(XM, y, { ...GEOM, coarse: true }, only)).toBe(0); // a finger does not
  });

  it("the wider touch radius is still a radius, not the whole rail", () => {
    const only: OverviewMarker[] = [{ t: 62, kind: "hot" }];
    const far = yOf(GEOM, 62) + MARKER_SNAP_TOUCH_PX + 2;
    expect(hitMarker(XM, far, { ...GEOM, coarse: true }, only)).toBeNull();
  });
});

function railTimeOf(y: number) {
  return ((y - GEOM.top) / GEOM.height) * GEOM.duration;
}

describe("rail geometry", () => {
  // ★ THE OPERATOR'S BUG: "the top of the preview gets cut off". A mark is centred on its time,
  // so one at t=0 hangs half its thickness above the canvas.
  it("never lets a mark hang off either end", () => {
    const h = 398;
    for (const thick of [1.5, 2, 2.5, 5, 14]) {
      expect(insetMark(0, thick, h)).toBe(0); // t = 0
      expect(insetMark(h, thick, h)).toBe(h - thick); // t = duration
      for (let y = 0; y <= h; y += 0.5) {
        const top = insetMark(y, thick, h);
        expect(top).toBeGreaterThanOrEqual(0);
        expect(top + thick).toBeLessThanOrEqual(h + 1e-9);
      }
    }
  });

  // ★ THE FIX THAT WASN'T. The first pass at "the top gets cut off" inset by the LINE's
  // thickness — and the test asserted exactly that, so it passed while the operator was still
  // looking at a clipped rail. A labelled mark's real height is its GLYPH (~13px), not its 1.6px
  // line, and the letter is centred on the same y; inset by the line alone and half the "A" is
  // still outside. The test was checking the wrong box, which is the only reason it agreed.
  it("keeps a labelled mark's LETTER inside, not just its line", () => {
    const h = 398;
    const line = 1.6;
    // The centre a labelled mark actually gets drawn at, top and bottom of the rail.
    const cyTop = insetMark(0, LABEL_BOX_PX, h) + LABEL_BOX_PX / 2;
    const cyBot = insetMark(h, LABEL_BOX_PX, h) + LABEL_BOX_PX / 2;
    for (const cy of [cyTop, cyBot]) {
      expect(cy - LABEL_BOX_PX / 2).toBeGreaterThanOrEqual(0);
      expect(cy + LABEL_BOX_PX / 2).toBeLessThanOrEqual(h + 1e-9);
      // …and its line, drawn on the same centre, is inside too.
      expect(cy - line / 2).toBeGreaterThanOrEqual(0);
      expect(cy + line / 2).toBeLessThanOrEqual(h + 1e-9);
    }
    // Insetting by the LINE (what the first fix did) leaves the glyph hanging off the top —
    // this is the assertion that would have failed, and did not exist.
    const wrongCy = insetMark(0, line, h) + line / 2;
    expect(wrongCy - LABEL_BOX_PX / 2).toBeLessThan(0);
  });

  it("leaves everything that already fits exactly where it was", () => {
    const h = 398;
    for (let y = 20; y <= h - 20; y += 1) expect(insetMark(y, 2, h)).toBeCloseTo(y - 1, 9);
  });

  // ★ ONE LANE DEFINITION, shared by the static tick and the hover highlight. If these could
  // drift, the highlight would sit in the opposite column from the thing it highlights.
  it("puts sections and markers in opposite halves, mirrored per side", () => {
    const W = 128;
    for (const side of ["left", "right"] as const) {
      const sec = laneRect("phrase", side, W);
      const cue = laneRect("hot", side, W);
      expect(sec.w).toBe(W / 2);
      expect(cue.w).toBe(W / 2);
      expect(sec.x).not.toBe(cue.x); // never the same column
      expect(sec.labelRight).toBe(sec.x > 0);
      expect(cue.labelRight).toBe(cue.x > 0);
    }
    // Cues sit toward the waveform: right half on a left rail, left half on a right rail.
    expect(laneRect("hot", "left", 128).x).toBe(64);
    expect(laneRect("hot", "right", 128).x).toBe(0);
    expect(laneRect("phrase", "left", 128).x).toBe(0);
    expect(laneRect("phrase", "right", 128).x).toBe(64);
  });

  it("every non-section family shares the markers lane", () => {
    for (const k of ["loop", "cue", "hot"] as const) {
      expect(laneRect(k, "left", 128).x).toBe(laneRect("hot", "left", 128).x);
      expect(markerLane(k)).toBe("markers");
    }
  });
});