// Which right-dock panel opens at BOOT — and why a shared @handle link beats a remembered one.
//
// ★ THE BUG THIS EXISTS TO KILL (thread 3b2ea067, measured on the two-origin rig). The dock a user
// last had open is restored from localStorage, and `publicHandle` is initialised from the URL path.
// Two effects then race at mount: one closes the docks when a public handle is set, the other
// CLEARS the public handle when any dock is open (App.tsx). With a restored dock, the second wins
// — so someone who last left Settings or People open, then follows a shared link to a live DJ,
// lands on the board with no profile, no "Listen live" button and no way in. The room is live, the
// page can see it is live, and there is no door. Reproduced and then fixed in the browser by
// clearing the stored key: the button came back.
//
// The deep link is an INTENT expressed right now; the restored dock is a preference from last time.
// A link someone just followed wins, so the restore is skipped for that load only — the stored
// value is left untouched, and the next ordinary load restores it as before.
export type RightDock = "settings" | "profile" | "discover" | "social" | null;

export function initialDock(storedDock: string | null, publicHandle: string | null, wideEnough: boolean): RightDock {
  if (!wideEnough) return null; // phones: docks are full-screen modals and always start closed
  if (publicHandle) return null; // a followed link outranks a remembered panel
  switch (storedDock) {
    case "settings":
    case "profile":
    case "discover":
    case "social":
      return storedDock;
    default:
      return null;
  }
}
