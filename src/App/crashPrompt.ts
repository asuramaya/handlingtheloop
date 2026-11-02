// WHAT TO ASK AT BOOT WHEN A CRASH GUARD IS STANDING.
//
// Two guards can disable stem work after a tab dies mid-job: the desktop GPU guard (a separation
// took the tab down) and the phone stem-download guard (decoding a cached set did). Both used to
// act SILENTLY. The GPU one also bounced the user's stem model to "off", so stems were later just
// off, with nobody having turned them off and nothing on screen saying why. The operator: "crash
// guard is silent and annoying, make it a prompt at reload instead so its not a silent disable".
//
// The rule now:
//   • the guard still BLOCKS at boot, before anything can re-run the job that crashed, so a
//     crash loop stays impossible without a human choosing it;
//   • and while a block stands, EVERY load asks: "Try again" lifts it, "Keep off" keeps it for
//     this load and asks again next time. A disable is never silent and never permanent-by-default.
// Pure so the wording and the which-prompts-when rule are testable without booting the app.

export interface CrashPrompt {
  id: "gpu" | "stems";
  title: string;
  body: string;
  accept: string;
  decline: string;
}

export interface CrashGuardState {
  /** GPU separation is blocked right now (this boot's crash, or one carried over). */
  gpuBlocked: boolean;
  /** The block was set by a crash detected on THIS boot (vs. carried over from earlier). */
  gpuCrashedNow: boolean;
  /** Label of the model that was running when it crashed, if known. */
  gpuModelLabel: string | null;
  /** Phone stem-download guard level: 0 normal, 1 auto-fetch paused, 2+ stems off. */
  stemFailLevel: number;
}

export function crashPrompts(s: CrashGuardState): CrashPrompt[] {
  const out: CrashPrompt[] = [];
  if (s.gpuBlocked) {
    const what = s.gpuModelLabel ? `${s.gpuModelLabel} stem separation` : "GPU stem separation";
    out.push({
      id: "gpu",
      title: s.gpuCrashedNow ? "The tab crashed while separating stems" : "Stem separation is paused after a crash",
      body: s.gpuCrashedNow
        ? `${what} took the page down last time, so it is paused to stop a crash loop. Tracks play as the plain mix until you choose.`
        : `${what} was paused after it crashed the page in an earlier session. Tracks play as the plain mix until you choose.`,
      accept: "Try again",
      decline: "Keep off",
    });
  }
  if (s.stemFailLevel >= 1) {
    out.push({
      id: "stems",
      title: "Loading stems crashed the tab",
      body:
        s.stemFailLevel >= 2
          ? "Downloading stems took the page down twice, so stems are off and tracks play as the plain mix."
          : "Downloading stems took the page down last time, so automatic stem downloads are paused. Asking for stems on a deck still works.",
      accept: "Try again",
      decline: "Keep off",
    });
  }
  return out;
}
