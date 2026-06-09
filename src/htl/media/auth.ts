// User-supplied YouTube credentials, stored locally and sent (per request) to
// our own Worker, which forwards them to YouTube so the user passes the "confirm
// you're not a bot" challenge with their OWN session. Stored only in this
// browser's localStorage; sent only to the same-origin Worker. See the in-app
// privacy notice for the trade-off this represents.
import { Store } from "../persistence";

export interface YtAuth {
  cookie?: string; // youtube.com Cookie header
  visitorData?: string; // browser-minted visitorData
  poToken?: string; // BotGuard PO token bound to that visitorData
}

const store = new Store<YtAuth>("ytauth", {}, 1);

export function getYtAuth(): YtAuth {
  return store.get();
}

export function setYtAuth(a: YtAuth): void {
  store.set(a);
}

export function clearYtAuth(): void {
  store.clear();
}

export function hasYtAuth(): boolean {
  const a = store.get();
  return !!(a.cookie || a.visitorData || a.poToken);
}

// Request headers carrying the credentials to the Worker (omitted when unset).
export function ytAuthHeaders(): Record<string, string> {
  const a = store.get();
  const h: Record<string, string> = {};
  if (a.cookie) h["x-htl-yt-cookie"] = a.cookie.trim();
  if (a.visitorData) h["x-htl-yt-visitor"] = a.visitorData.trim();
  if (a.poToken) h["x-htl-yt-potoken"] = a.poToken.trim();
  return h;
}
