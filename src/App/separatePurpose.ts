// Which separation purposes force a fresh compute. Extracted from forceSeparate because this one mapping
// is what decides whether a remote's stem request joins the host's running job or starts a second
// separation of the same track — so it gets a test that has been seen to fail, not just a comment.
export type SeparatePurpose = "reanalyze" | "request";

/** Re-analyze forces (the user asked for a fresh compute). A request never does (it must join running
 *  work or use the cache, or the host separates the same track twice). */
export function separationForces(purpose: SeparatePurpose): boolean {
  return purpose === "reanalyze";
}
