// Client for the htl SaaS account layer (server: server/accounts.ts). Auth is a
// server-side redirect flow, so "sign in" / "connect" are full-page navigations;
// session state lives in an httpOnly cookie and is read back via /api/me.

export type Provider = "google" | "spotify";

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


// --- Playlist sync ---------------------------------------------------------
export type Service = "youtube" | "spotify";

export interface ServicePlaylist {
  id: string;
  title: string;
  count: number;
  thumbnail: string | null;
}

/** The signed-in user's Spotify playlists (YouTube ones come from @htl/media). */
export async function fetchSpotifyPlaylists(): Promise<ServicePlaylist[]> {
  const res = await fetch("/api/me/spotify/playlists", { credentials: "same-origin" });
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

/** Free-text search of the destination service (manual per-track re-match). */
export const syncSearch = (dest: Service, query: string) =>
  postJson<{ candidates: Candidate[] }>("/api/sync/search", { dest, query }).then((r) => r.candidates);

/** Phase 3a: create the destination playlist. */
export const syncCreate = (dest: Service, name: string) =>
  postJson<{ playlistId: string; url: string }>("/api/sync/create", { dest, name });

/** Phase 3b: append a chunk of confirmed ids (videoIds for YT, uris for Spotify). */
export const syncAdd = (dest: Service, playlistId: string, ids: string[]) =>
  postJson<{ added: number }>("/api/sync/add", { dest, playlistId, ids }).then((r) => r.added);
