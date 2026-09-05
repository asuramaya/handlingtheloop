// WHERE THE MIX HAPPENS — chosen from the track's STRUCTURE, not from arithmetic.
//
// The analysis layer already finds section boundaries by chroma self-similarity and labels
// repeated sections rekordbox-style (A/B/C/D — a segment similar enough to an earlier one reuses
// its letter). The auto-mixer had that data and used only half of it: `computeMixOut` picked the
// phrase boundary nearest "end minus a blend minus four seconds", and `computeMixIn` took the
// first phrase past the content start. Both are structurally blind — they know where the seams
// are but not what the sections MEAN, so the mixer could just as easily leave a track in the
// middle of its second verse as at the end of its last chorus.
//
// The labels make the difference available for free. The most-repeated label is, essentially
// always, the chorus/hook; its LAST occurrence is where a DJ leaves. The first label that repeats
// later is where the track really begins, as opposed to its intro; that is where a DJ brings the
// next one in. Neither inference needs a genre model or a downbeat classifier — just the letters
// already sitting on the beatgrid.
//
// Every function here is pure and falls back to the old arithmetic when a track has no usable
// structure (short clips, spoken word, anything the SSM could not segment).

export interface Sections {
  /** Section start times, ascending. */
  starts: readonly number[];
  /** Parallel repeat labels ("A", "B", …). Same length as `starts` when present. */
  labels: readonly string[];
  /** Where real content begins (loudness-trimmed), and the musical end before any dead tail. */
  firstSound: number;
  lastSound: number;
  duration: number;
}

/** The end time of section `i` — the next section's start, or the musical end for the last one. */
function sectionEnd(s: Sections, i: number): number {
  return i + 1 < s.starts.length ? s.starts[i + 1] : s.lastSound;
}

/** The label that repeats most — the hook. Ties go to whichever recurs LATEST, because that is
 *  the one the track is actually built around by the time it ends. Null when nothing repeats
 *  (every section unique = no usable structure). */
export function dominantLabel(s: Sections): string | null {
  if (!s.labels.length || s.labels.length !== s.starts.length) return null;
  const count = new Map<string, number>();
  const last = new Map<string, number>();
  for (let i = 0; i < s.labels.length; i++) {
    const L = s.labels[i];
    if (!L) continue;
    count.set(L, (count.get(L) ?? 0) + 1);
    last.set(L, i);
  }
  let best: string | null = null;
  for (const [L, n] of count) {
    if (n < 2) continue; // a section that never comes back is not a hook
    if (!best) {
      best = L;
      continue;
    }
    const bn = count.get(best) as number;
    if (n > bn || (n === bn && (last.get(L) as number) > (last.get(best) as number))) best = L;
  }
  return best;
}

/** Where to mix OUT of the outgoing track.
 *
 *  Preference order:
 *   1. the end of the LAST repeat of the dominant label — leaving on the final chorus;
 *   2. the latest section boundary whose blend still finishes before the musical end;
 *   3. the old arithmetic target (musical end − blend − guard), snapped by the caller.
 *
 *  A candidate is only accepted if the whole blend fits before `lastSound` and it is not so early
 *  that the track is cut off — a 24-bar blend leaving at 35 % is a skip, not a mix. */
export function chooseMixOut(s: Sections, barsSeconds: number, endGuard: number): number {
  const latest = s.lastSound - barsSeconds; // the blend must COMPLETE by the musical end
  const earliest = Math.max(s.firstSound, s.duration * 0.35);
  const arithmetic = s.lastSound - barsSeconds - endGuard;
  const usable = (t: number) => t <= latest && t >= earliest;

  if (s.starts.length && s.labels.length === s.starts.length) {
    const hook = dominantLabel(s);
    if (hook) {
      for (let i = s.labels.length - 1; i >= 0; i--) {
        if (s.labels[i] !== hook) continue;
        const out = sectionEnd(s, i);
        if (usable(out)) return out;
        break; // only the LAST repeat is the natural exit; an earlier one is mid-track
      }
    }
  }

  // No hook, or the hook ends too late to blend out of it: take the latest boundary that works.
  let best: number | null = null;
  for (const t of s.starts) {
    if (usable(t) && (best == null || t > best)) best = t;
  }
  if (best != null) return best;

  return Math.max(earliest, Math.min(arithmetic, latest));
}

/** The first section that is BODY rather than intro — the first label that comes back later. An
 *  intro is by definition the part that never recurs. Null when there is no repeat structure. */
export function firstBodySection(s: Sections): number | null {
  if (!s.labels.length || s.labels.length !== s.starts.length) return null;
  for (let i = 0; i < s.labels.length; i++) {
    const L = s.labels[i];
    if (!L) continue;
    for (let j = i + 1; j < s.labels.length; j++) {
      if (s.labels[j] === L) return i;
    }
  }
  return null;
}

/** Where to drop the needle on the INCOMING track, so its first body section lands at the END of
 *  the blend — its intro rides under the outgoing track's outro and the two arrive together at
 *  the moment the new track properly starts.
 *
 *  `floor` is the earliest legal position (the track's first downbeat); the caller snaps the
 *  result to a beat. A body section closer to the start than the blend is long simply plays from
 *  the floor: there is nothing to trim. */
export function chooseMixIn(s: Sections, barsSeconds: number, floor: number): number {
  const bodyIdx = firstBodySection(s);
  let body: number | null = bodyIdx != null ? s.starts[bodyIdx] : null;

  // No repeat structure: fall back to the first boundary at/after the content start, which is
  // what the mixer did before labels existed.
  if (body == null) {
    for (const t of s.starts) {
      if (t >= s.firstSound - 0.1) {
        body = t;
        break;
      }
    }
  }
  if (body == null) body = s.firstSound;
  if (body <= floor + 0.2) return floor; // negligible intro → start at "1"
  return Math.max(floor, body - barsSeconds);
}

// Phrase-length blends. A blend that straddles a section boundary sounds like an accident; one
// that fills the section it lives in sounds intended. Real phrases are 4/8/16/32 bars, so the
// fitted length is quantised to those rather than used raw.
const BLEND_STEPS = [4, 8, 12, 16, 24, 32];

/** Fit the blend to the section it will actually happen in, capped by the planner's request.
 *  Returns bars. Falls back to `requested` when there is no section to measure. */
export function blendBarsFor(s: Sections, mixOut: number, bpm: number, requested: number): number {
  if (!bpm || bpm <= 0 || !s.starts.length) return requested;
  const secPerBar = (4 * 60) / bpm;

  // The section the mix-out sits at the end of — measure BACK from it, since that is the material
  // the outgoing track has left to give.
  let span = 0;
  for (let i = s.starts.length - 1; i >= 0; i--) {
    if (s.starts[i] <= mixOut - 0.05) {
      span = mixOut - s.starts[i];
      break;
    }
  }
  // Also never plan a blend longer than the runway to the musical end.
  const runway = s.lastSound - mixOut;
  const fitBars = Math.min(span, runway) / secPerBar;
  if (!(fitBars > 0)) return requested;

  let best = BLEND_STEPS[0];
  for (const b of BLEND_STEPS) {
    if (b <= fitBars && b <= requested) best = b;
  }
  return best;
}
