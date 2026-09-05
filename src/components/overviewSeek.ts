// WHERE AN OVERVIEW DRAG LANDS, AND WHAT IT WILL SNAP TO — the rail's clientY → track-time
// mapping and its marker hit-test, on their own so they can be swept rather than eyeballed.
//
// ★ THE BUG THIS EXISTS TO NAME. The rail has a magnetic marker snap, documented in its own words
// as a CLICK affordance: "special click zones that skip to them precisely". It was applied on
// every `onPointerMove` as well — so a DRAG was snapping too. On the operator's rail (398 CSS px
// for a 3:35 track) MARKER_SNAP_PX = 7 is a radius of 3.8 SECONDS: drag past a cue or a phrase
// boundary and the playhead is yanked onto it and held there until you clear the zone. With
// phrase markers every ~8 bars, a large fraction of the rail is inside somebody's snap zone.
// That is what "dragging on the stem preview is coarse" was: the drag was quantised to markers.
//
// A click and a drag are two different gestures asking two different questions — "take me exactly
// to that cue" and "let me scrub" — and they had one answer. So the snap is now a parameter: on
// for the press that starts the gesture, off for every move after it.
//
// ★ AND ONE ANSWER FOR TWO QUESTIONS, DELIBERATELY, WHERE IT IS THE SAME QUESTION. The hover
// highlight ("you are in the zone that will jump to this marker") and the snap itself ("jump to
// this marker") must never be able to disagree — a rail that lights up one marker and then seeks
// to a different one is worse than no highlight at all. So `hitMarker` is the ONLY place that
// decides, and `overviewSeekTime` is defined in terms of it rather than repeating the search.

/** A click within this many CSS px of a marker lands on that marker's exact stored time. */
export const MARKER_SNAP_PX = 7;
/** ★ AND A FINGER IS NOT A CURSOR. 7px is a fine target for a mouse and a joke for a thumb — the
 *  platform touch minimum is 44px, and while a rail cannot give a marker that much without every
 *  marker swallowing its neighbours, it can stop pretending a fingertip lands where a pixel does. */
export const MARKER_SNAP_TOUCH_PX = 14;

/** Which family a marker belongs to. Also decides which half of the rail it is drawn in. */
export type MarkerKind = "phrase" | "loop" | "cue" | "hot" | "sloop";

export interface OverviewMarker {
  t: number;
  kind: MarkerKind;
}

// ★ TIES ARE BROKEN BY WHO PUT THE MARKER THERE. A hot cue sitting exactly on a drop is the
// common case, not the corner case — you place it there ON PURPOSE — and "nearest wins, and if
// equal then whatever the draw loop happened to push last" is a coin toss between the operator's
// own cue and a phrase boundary the analyser guessed. A thing you placed always beats a thing
// that was derived for you.
// A saved loop is placed by hand on a pad, exactly like a hot cue, so it wins ties the same way.
const PRIORITY: Record<MarkerKind, number> = { hot: 3, cue: 3, sloop: 3, loop: 2, phrase: 1 };
/** How much a marker's identity matters when two labels cannot both fit. Same order the snap
 *  tie-break uses, for the same reason: a thing you placed outranks a thing that was derived. */
export const markerPriority = (kind: MarkerKind): number => PRIORITY[kind] ?? 0;

export interface OverviewGeom {
  /** The rail's top edge in client coordinates. */
  top: number;
  /** The rail's height in CSS px. */
  height: number;
  /** Track length in seconds. */
  duration: number;
  /** The rail's left edge in client coordinates. */
  left: number;
  /** The rail's width in CSS px. */
  width: number;
  /** Which edge of the board this rail sits on — decides which half is which lane. */
  side: "left" | "right";
  /** A coarse pointer (finger/stylus) is driving. Widens the snap radius. */
  coarse?: boolean;
}

/**
 * Which lane the pointer is in.
 *
 * ★ THE SPLIT HAS TO BE REAL, NOT DECORATIVE. Sections and markers were given a half each so they
 * would stop overlapping visually — but the hit-test still only looked at Y, so a click on the
 * sections half would happily snap to a hot cue in the OTHER column, and hovering one lane lit up
 * markers in the other. Two lanes that share one hit-test are one lane wearing a divider: the
 * operator hit it immediately ("when i try to click on the left side the a b c sections get
 * triggered"). X decides which family you are addressing; Y decides where in it.
 */
export function laneAtX(clientX: number, geom: OverviewGeom): "sections" | "markers" {
  const rightHalf = clientX - geom.left >= geom.width / 2;
  // A left-hand rail has the waveform to its RIGHT, so its right half is the markers lane.
  const inward = geom.side === "left";
  return rightHalf === inward ? "markers" : "sections";
}

/** Raw pixel → time, with no snapping and both ends clamped. */
export function railTime(clientY: number, geom: OverviewGeom): number {
  const { top, height, duration } = geom;
  if (!(duration > 0) || !(height > 0)) return 0;
  return Math.max(0, Math.min(1, (clientY - top) / height)) * duration;
}

/**
 * The marker a press at `clientY` would snap to, or null when the pointer is in open water.
 * This is the ONE authority: the hover highlight and the seek both ask it, so what lights up is
 * always exactly what a click would do.
 */
export function hitMarker(
  clientX: number,
  clientY: number,
  geom: OverviewGeom,
  markers: readonly OverviewMarker[],
): number | null {
  const { height, duration } = geom;
  if (!(duration > 0) || !(height > 0) || markers.length === 0) return null;
  // ★ A NARROW RAIL CANNOT ASK A FINGER TO PICK A COLUMN. At the mobile rail's 40px each lane is
  // 20px wide — narrower than a fingertip — so demanding that a touch land in the correct half to
  // reach a marker makes half the rack unhittable. The same width test that moves the LABELS into
  // one column drops the lane requirement from the hit-test: wide rail, two precise columns;
  // narrow rail, one target and nearest-wins. The lanes stay a visual separation either way,
  // because a TICK is 1.3px and always fits.
  const laneFree = labelsShareColumn(geom.width);
  const lane = laneAtX(clientX, geom);
  const t = railTime(clientY, geom);
  const tol = ((geom.coarse ? MARKER_SNAP_TOUCH_PX : MARKER_SNAP_PX) / height) * duration;
  let best: number | null = null;
  let bestDist = Infinity;
  let bestPri = -1;
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    if (!laneFree && markerLane(m.kind) !== lane) continue; // the other column is not yours to hit
    const d = Math.abs(m.t - t);
    if (d > tol) continue;
    const pri = PRIORITY[m.kind] ?? 0;
    // Strictly closer wins; at the same distance the higher priority wins; at both equal the
    // first one found wins, so the result never depends on draw order.
    if (d < bestDist - 1e-9 || (Math.abs(d - bestDist) <= 1e-9 && pri > bestPri)) {
      best = i;
      bestDist = d;
      bestPri = pri;
    }
  }
  return best;
}

/**
 * @param snap TRUE only for the pointerdown that begins the gesture. Every move must pass false,
 *             or the drag is quantised to whatever markers it passes.
 */
export function overviewSeekTime(
  clientX: number,
  clientY: number,
  geom: OverviewGeom,
  markers: readonly OverviewMarker[],
  snap: boolean,
): number {
  if (!snap) return railTime(clientY, geom);
  const i = hitMarker(clientX, clientY, geom, markers);
  return i == null ? railTime(clientY, geom) : markers[i].t;
}

/** Which half of the rail a family is drawn in. Sections and markers get one each so a cue can
 *  never sit on top of a phrase boundary — they used to share the full width and only their
 *  LABELS were kept apart, which is why a dense track looked like one indistinguishable comb. */
export function markerLane(kind: MarkerKind): "sections" | "markers" {
  return kind === "phrase" ? "sections" : "markers";
}

/**
 * Where a marker of this kind is drawn, and which way its label opens.
 *
 * ★ ONE DEFINITION, BECAUSE TWO PASSES DRAW THE SAME TICK. The static layer rasterises markers
 * once per track; the per-frame composite redraws the HOVERED one on top, swollen. I first wrote
 * the lane maths twice — once in each — which is precisely the shape that ships a highlight
 * sitting in the opposite column from the tick it is supposed to be highlighting the moment
 * either copy is touched. The rail's side is the only input that differs between them.
 */
export function laneRect(kind: MarkerKind, side: "left" | "right", width: number) {
  // A left-hand rail has the waveform to its RIGHT, so "inward" is its right half. Sections open
  // toward the app's edge, cues and loop edges toward the waveform.
  const inward = side === "left";
  const rightHalf = markerLane(kind) === "sections" ? !inward : inward;
  return { x: rightHalf ? width / 2 : 0, w: width / 2, labelRight: rightHalf };
}

/**
 * Keep a fixed-height mark fully inside the rail.
 *
 * ★ WHY NOT "PAD THE TIME AXIS". The obvious reading of "the top gets cut off, it needs padding"
 * is to inset the whole t → y mapping. That would be wrong twice over: the waveform is sampled
 * into every one of the rail's `h` rows, so the picture and the markers would drift apart unless
 * the sampler were re-mapped too; and the click mapping would have to move with it or every seek
 * would land where it no longer looks. The mapping is fine. What is broken is only that a tick is
 * CENTRED on its time, so one at t=0 (or t=duration) puts half its thickness outside the canvas
 * and reads as clipped. Nudge those two, change nothing else, and the picture, the markers, the
 * highlight and the click all still agree to the pixel.
 *
 * ★ AND A LABELLED MARK IS AS TALL AS ITS LETTER, NOT AS TALL AS ITS LINE. Fixing this for the
 * 1.6px line alone left the glyph — which is centred on the SAME y and is ~11px tall — still
 * hanging half of itself off the top, which is what the operator was still seeing after the first
 * fix. Pass the label's box as `thickness` for anything that carries one: at the very edge the
 * mark shifts down by a few px so the letter clears, which is the "little padding" that was asked
 * for, and everywhere else it is the identity.
 *
 * @returns the top edge to draw at, for a mark of `thickness` px nominally centred on `y`.
 */
export function insetMark(y: number, thickness: number, height: number): number {
  return Math.max(0, Math.min(height - thickness, y - thickness / 2));
}

/** The vertical box a rail label occupies, in CSS px — the glyph plus the breathing room that
 *  keeps it off the rail's edge. Both the static tick and the hover highlight size their inset
 *  from this, so a labelled mark is never clipped at either end. */
export const LABEL_BOX_PX = 13;

/** A label needs its glyph plus enough line either side to still read as a line with a break in
 *  it. Below this, a lane cannot host a label at all — at the mobile rail's 16px lane a one-char
 *  gap left 1px of line per side, which is a letter floating in nothing, not a marked line. */
export const LABEL_MIN_LANE_PX = 26;

/**
 * Below a certain rail width the two lanes are too narrow to each hold a label, so the LABELS
 * share one column across the whole rail while the TICKS stay split.
 *
 * ★ WHICH HALF A TICK GROWS FROM IS WHAT NAMES ITS FAMILY — that survives at any width, because a
 * tick is ~1.3px. A 13px glyph box does not. So the thing that cannot fit yields, and the thing
 * that can keeps doing its job. Everything still resolves through resolveLabels, which is handed
 * `shared` so two labels from OPPOSITE lanes cannot overprint once they share the column.
 */
export function labelsShareColumn(railWidth: number): boolean {
  return railWidth / 2 < LABEL_MIN_LANE_PX;
}

/**
 * Is this region too short to be drawn as a region on the rail?
 *
 * ★ A LOOP SHORTER THAN ITS OWN LABELS FIGHTS ITSELF. At whole-song scale a 1-beat loop is a
 * couple of pixels tall, so its IN and OUT ticks land on top of each other: the two labels
 * overprint into an unreadable blob, and because a magnetic snap resolves to the NEAREST marker,
 * the sliver of rail that belongs to the far edge can shrink below one pixel — the operator found
 * exactly this ("a short loop fights itself start and end and it overlaps making one of the tails
 * unclickable"). Two marks that cannot be told apart, and one of them unreachable.
 *
 * A region too small to be a region is a POINT. Collapsed, a short loop draws once, labels once,
 * and registers ONE snap target, so there is nothing to fight over.
 */
export function loopIsCollapsed(startY: number, endY: number): boolean {
  return Math.abs(endY - startY) < LABEL_BOX_PX;
}

/**
 * Which labels actually get drawn when several marks crowd one another.
 *
 * ★ TICKS CAN TOUCH; LABELS CANNOT. A tick is ~1.3px and several of them a few pixels apart are
 * perfectly legible as a cluster — but a LABEL is a 13px glyph box, so two of them that close
 * overprint into a blob. The operator photographed exactly that: a hot cue and a saved loop at
 * nearly the same instant rendering as an unreadable "41", with the loop's own OUT below it.
 *
 * The loop-collapse rule (loopIsCollapsed) fixed one instance of this — the two edges of a SINGLE
 * loop — and I stopped there, because I was still thinking of markers as independent points.
 * Crowding is a relationship BETWEEN marks, and it happens between any two in the same lane: a
 * cue on a saved loop, two saved loops, a cue on a loop edge. This is the general rule.
 *
 * Every mark still draws its tick and stays snappable — only the LABEL yields, highest priority
 * first, and the hover highlight draws the label of whatever you point at, so nothing is lost.
 *
 * @returns a parallel array: true where that mark should draw its label.
 */
export function resolveLabels(
  marks: readonly { y: number; lane: "sections" | "markers"; priority: number; label: string }[],
  /** True when both lanes' labels are drawn in ONE column (a narrow rail — see
   *  labelsShareColumn), so a section and a cue can collide with each other too. */
  shared = false,
): boolean[] {
  const out = new Array<boolean>(marks.length).fill(false);
  // Deterministic order: strongest claim first, then top of the rail down, then input order —
  // so the same rack always resolves the same way, whatever order the draw loop pushed marks in.
  const order = marks
    .map((_, i) => i)
    .sort((a, b) => marks[b].priority - marks[a].priority || marks[a].y - marks[b].y || a - b);
  const claimed: Record<string, number[]> = { sections: [], markers: [] };
  for (const i of order) {
    const m = marks[i];
    if (!m.label) continue; // an unlabelled tick reserves nothing — it cannot block a real label
    const lane = claimed[shared ? "markers" : m.lane];
    if (lane.some((y) => Math.abs(y - m.y) < LABEL_BOX_PX)) continue;
    lane.push(m.y);
    out[i] = true;
  }
  return out;
}
