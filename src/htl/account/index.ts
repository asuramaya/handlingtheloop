// Client for the htl SaaS account layer (server: server/accounts.ts). Auth is a
// server-side redirect flow, so "sign in" / "connect" are full-page navigations;
// session state lives in an httpOnly cookie and is read back via /api/me.

export type Provider = "google" | "spotify" | "tidal";

export interface AccountUser {
  id: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
}
export interface Me {
  user: AccountUser | null;
  connections: Provider[];
}

/** Who's signed in + which services they've linked (user:null when signed out). */
export async function fetchMe(signal?: AbortSignal): Promise<Me> {
  const res = await fetch("/api/me", { signal, credentials: "same-origin" });
  if (!res.ok) return { user: null, connections: [] };
  return (await res.json()) as Me;
}

// Redirect entry points (full-page navigation kicks off the OAuth dance).
export const startGoogleSignIn = () => {
  window.location.href = "/api/auth/google/start";
};
export const startSpotifyConnect = () => {
  window.location.href = "/api/auth/spotify/start";
};
export const startTidalConnect = () => {
  window.location.href = "/api/auth/tidal/start";
};

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
}

export async function disconnectService(provider: Provider): Promise<void> {
  await fetch("/api/connections/disconnect", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider }),
  });
}

// --- Profile (identity + member-since + top songs) -------------------------
export interface TopTrack {
  videoId: string;
  title: string;
  artist: string;
  thumbnail: string | null;
  plays: number;
}
export interface Profile {
  user: AccountUser & { memberSince: number | null };
  connections: Provider[];
  topTracks: TopTrack[];
}

/** The signed-in user's full profile (identity, member-since, top songs). Null if signed out. */
export async function fetchProfile(signal?: AbortSignal): Promise<Profile | null> {
  const res = await fetch("/api/me/profile", { signal, credentials: "same-origin" });
  if (!res.ok) return null;
  return (await res.json()) as Profile;
}

// Per-track de-dupe so reloads, rewinds, model/stem re-derives, and room-driven re-loads of
// the SAME track don't each fire a D1 write. logPlay used to POST on every track load — a
// careless write (each one is a D1 UPSERT). One play per track per window is plenty for stats.
const PLAY_LOG_WINDOW_MS = 60_000;
const lastPlayLog = new Map<string, number>();

/** Record one play of a track for the signed-in user's stats. Fire-and-forget, de-duped. */
export function logPlay(t: { videoId: string; title?: string; artist?: string; thumbnail?: string | null }): void {
  const now = Date.now();
  const prev = lastPlayLog.get(t.videoId);
  if (prev !== undefined && now - prev < PLAY_LOG_WINDOW_MS) return; // already logged this track recently
  lastPlayLog.set(t.videoId, now);
  void fetch("/api/me/play", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(t),
  }).catch(() => {
    /* best-effort stats — never surface a failure */
  });
}


// --- Playlist sync ---------------------------------------------------------
export type Service = "youtube" | "spotify" | "tidal";

export interface ServicePlaylist {
  id: string;
  title: string;
  count: number;
  thumbnail: string | null;
  ownerName?: string | null; // playlist owner's display name (Spotify)
  ownedByMe?: boolean; // false = followed / shared-with-me (Spotify may block reading its tracks)
}

/** The signed-in user's Spotify playlists (YouTube ones come from @htl/media). */
export async function fetchSpotifyPlaylists(): Promise<ServicePlaylist[]> {
  const res = await fetch("/api/me/spotify/playlists", { credentials: "same-origin" });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as { error?: string }).error || `HTTP ${res.status}`);
  return (j as { playlists: ServicePlaylist[] }).playlists;
}

/** The signed-in user's TIDAL playlists. */
export async function fetchTidalPlaylists(): Promise<ServicePlaylist[]> {
  const res = await fetch("/api/me/tidal/playlists", { credentials: "same-origin" });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as { error?: string }).error || `HTTP ${res.status}`);
  return (j as { playlists: ServicePlaylist[] }).playlists;
}

// Two-phase sync: preview/match → review → commit. Keeps the user in control
// (review before write) and stays under Worker limits (client pages each step).
export type Confidence = "high" | "medium" | "low" | "none";

export interface SourceTrack {
  title: string;
  artist: string;
  duration: number;
  thumbnail: string | null;
  isrc: string | null;
  spotifyId: string | null;
  videoId: string | null;
}
export interface Candidate {
  id: string; // youtube videoId or spotify uri
  kind: "video" | "uri";
  title: string;
  artist: string;
  duration: number;
  thumbnail: string | null;
}
export interface MatchRow {
  index: number;
  source: SourceTrack;
  best: Candidate | null;
  confidence: Confidence;
  alternatives: Candidate[];
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as { error?: string }).error || `HTTP ${res.status}`);
  return j as T;
}

/** Phase 1: the source playlist's tracks (with anchors). */
export const syncReadSource = (source: Service, sourcePlaylistId: string) =>
  postJson<{ name: string; tracks: SourceTrack[] }>("/api/sync/source", { source, sourcePlaylistId });

/** Phase 2: match a slice of source tracks on the destination (no writes). */
export const syncMatch = (dest: Service, tracks: SourceTrack[], startIndex: number) =>
  postJson<{ rows: MatchRow[] }>("/api/sync/match", { dest, tracks, startIndex }).then((r) => r.rows);

/** Map a raw sync/import error to an actionable message. Spotify blocks third-party API
    reads of playlists it owns (editorial/algorithmic) and of some only shared with you
    (list succeeds, items 403/404); TIDAL rate-limits (429) a big playlist's paged item
    reads, and 403/404s ones you don't own. Shared by SyncPanel + the Library quick-import. */
export function friendlySyncError(msg: string): string {
  if (/\[\/playlists\/.*\/items\]/.test(msg) && /\bspotify (403|404)\b/i.test(msg)) {
    return "Spotify won't let apps read this playlist's tracks — it's one Spotify owns (Discover Weekly, Daily Mix, an editorial mix…) or one that was only shared with you. In the Spotify app, open it and tap ⋯ → Add to your own library (or duplicate it), then import that copy.";
  }
  if (/premium/i.test(msg) || /\bspotify 403\b/i.test(msg)) {
    return "Spotify is blocking this right now — its API currently needs the app owner to hold an active Premium subscription (a temporary Spotify limitation that can take a few hours to clear). Try again later, or import to YouTube instead.";
  }
  if (/\btidal 429\b/i.test(msg)) {
    return "TIDAL rate-limited this import (it happens on large playlists) — the import backs off and retries, but a very big one can still trip it. Wait a few seconds and try again.";
  }
  if (/\btidal (403|404)\b/i.test(msg) && /\[\/playlists\//.test(msg)) {
    return "TIDAL won't let apps read this playlist — it's one you don't own or that isn't shared at the API level. In TIDAL, add it to your own collection (or recreate it), then import that copy.";
  }
  return msg;
}

/** Free-text search of the destination service (manual per-track re-match). */
export const syncSearch = (dest: Service, query: string) =>
  postJson<{ candidates: Candidate[] }>("/api/sync/search", { dest, query }).then((r) => r.candidates);

/** Phase 3a: create the destination playlist. */
export const syncCreate = (dest: Service, name: string) =>
  postJson<{ playlistId: string; url: string }>("/api/sync/create", { dest, name });

/** Phase 3b: append a chunk of confirmed ids (videoIds for YT, uris for Spotify). */
export const syncAdd = (dest: Service, playlistId: string, ids: string[]) =>
  postJson<{ added: number }>("/api/sync/add", { dest, playlistId, ids }).then((r) => r.added);

export { usePlaylistSource, type PlaylistSource } from "./usePlaylistSource";
