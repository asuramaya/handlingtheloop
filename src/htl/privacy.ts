// Streaming privacy. When you screen-share or stream a set, your account name and
// email shouldn't be on screen. So PII (participant names, emails) renders MASKED by
// default, behind one shared reveal switch — flip it to read the real values, flip it
// back before you go live. The switch is a tiny module-level store so every surface
// (the session roster, the Accounts panel) shares one state and one toggle.
import { useSyncExternalStore } from "react";

let revealed = false;
const subs = new Set<() => void>();

export function setRevealed(v: boolean): void {
  if (revealed === v) return;
  revealed = v;
  for (const f of subs) f();
}
export function toggleRevealed(): void {
  setRevealed(!revealed);
}

/** Subscribe a component to the global reveal switch. */
export function usePrivacyRevealed(): boolean {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => revealed,
    () => revealed,
  );
}

const DOT = "•";

/** "Hector Q" → "H••••" — first letter, the rest dotted (length hidden). */
export function maskName(name: string): string {
  const t = (name ?? "").trim();
  if (!t) return DOT.repeat(4);
  return t[0] + DOT.repeat(4);
}

/** "hector.qzd12@gmail.com" → "h••••@g•••.com" — first letters + TLD only. */
export function maskEmail(email: string): string {
  const t = (email ?? "").trim();
  const at = t.indexOf("@");
  if (at < 1) return maskName(t);
  const local = t.slice(0, at);
  const domain = t.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const tld = dot >= 0 ? domain.slice(dot) : "";
  const dHead = domain[0] ?? DOT;
  return `${local[0]}${DOT.repeat(4)}@${dHead}${DOT.repeat(3)}${tld}`;
}
