// Is this stem apply a literal repeat of the one the deck already holds?
//
// Applying stems is not cheap or idempotent: it restarts the pyramid build, re-packs four stems to
// int16 on the MAIN THREAD, and re-seats playback. A remote stem request that joins the host's own
// separation resumes on the same job result as the host's derive, and both used to apply it back to
// back at the moment stems land. Skipping the second apply removes that — but only a LITERAL repeat:
//
//  • keyed on object IDENTITY, not content — a re-analyze produces a NEW set and must still replace
//    the old one, however similar;
//  • never for null — clearing stems is how callers force the plain-mix fallback, and it must always
//    run, including when the deck is already clear;
//  • the neural flag and track must match too, so an upgrade or a different track still applies.

export interface StemApply {
  stems: unknown | null;
  neural: boolean;
  videoId: string | null;
}

export function isSameStemApply(held: StemApply, next: StemApply): boolean {
  return next.stems !== null && next.stems === held.stems && next.neural === held.neural && next.videoId === held.videoId;
}
