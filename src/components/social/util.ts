// Small shared helpers for the social surface (SocialScreen + its sub-components).

// Navigate to a public profile /@handle (App's PublicProfileRoute listens for popstate).
export function goToHandle(handle: string): void {
  window.history.pushState(null, "", `/@${handle}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// "just now" / "3m in" / "2h in" — how long a participant has been in the session.
export function ago(ms: number): string {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m in`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h in`;
  return `${Math.floor(h / 24)}d in`;
}

// Phone vs desktop glyph for a roster row, by the device's reported kind.
export function deviceIcon(kind: string): string {
  return /iphone|ipad|android|phone|mobile|tablet/i.test(kind) ? "📱" : "💻";
}
