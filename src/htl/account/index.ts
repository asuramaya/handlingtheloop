// Client for the htl SaaS account layer (server: server/accounts.ts). Auth is a
// server-side redirect flow, so "sign in" / "connect" are full-page navigations;
// session state lives in an httpOnly cookie and is read back via /api/me.

export type Provider = "google" | "spotify" | "tidal";

export interface AccountUser {
  id: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
  // Public identity (server publicIdentity()). `handle` is null until claimed;
  // displayName/avatar already fall back to the Google-mirror server-side.
  handle?: string | null;
  displayName?: string | null;
  bio?: string | null;
  private?: boolean; // unlisted account + follow-approval (own profile only)
  hidePresence?: boolean; // never expose `online`, even to friends
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

/** Permanently delete the signed-in account (M3). `confirm` must echo the user's @handle
 *  (or "DELETE" for a handle-less account) — the server rejects a mismatch. Irreversible. */
export async function deleteMyAccount(confirm: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch("/api/me/delete", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm }),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return { ok: r.ok, error: j.error };
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
  counts?: FollowCounts;
}

/** The signed-in user's full profile (identity, member-since, top songs). Null if signed out. */
export async function fetchProfile(signal?: AbortSignal): Promise<Profile | null> {
  const res = await fetch("/api/me/profile", { signal, credentials: "same-origin" });
  if (!res.ok) return null;
  return (await res.json()) as Profile;
}

// --- Public @handle + profile edits ----------------------------------------
export interface HandleCheck {
  available: boolean;
  handle?: string; // the cleaned (case-preserved) form the server accepted
  reason?: string; // when unavailable: "taken" or a validation message
}

/** Live availability/validity check for a candidate handle (sign-in gated). */
export async function checkHandle(h: string, signal?: AbortSignal): Promise<HandleCheck> {
  const res = await fetch(`/api/handle/check?h=${encodeURIComponent(h)}`, { signal, credentials: "same-origin" });
  if (!res.ok) return { available: false, reason: "error" };
  return (await res.json()) as HandleCheck;
}

/** Claim or rename the signed-in user's @handle. */
export async function claimHandle(handle: string): Promise<{ ok: boolean; handle?: string; error?: string }> {
  const res = await fetch("/api/me/handle", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  const j = (await res.json().catch(() => ({}))) as { handle?: string; error?: string };
  return res.ok ? { ok: true, handle: j.handle } : { ok: false, error: j.error };
}

/** Update the user-owned public profile fields (display name / bio / avatar URL / privacy). */
export async function saveProfile(p: {
  displayName?: string;
  bio?: string;
  avatarUrl?: string | null;
  private?: boolean;
  hidePresence?: boolean;
}): Promise<boolean> {
  const res = await fetch("/api/me/profile", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(p),
  });
  return res.ok;
}

/** Upload a new avatar image (jpg/png/gif/webp, ≤2 MB). Stored in R2, served from our origin —
 *  returns the new avatar_url. The server validates by magic bytes, not the content-type. */
export async function uploadAvatar(file: Blob): Promise<{ ok: boolean; avatarUrl?: string; error?: string }> {
  const res = await fetch("/api/me/avatar", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  const j = (await res.json().catch(() => ({}))) as { avatarUrl?: string; error?: string };
  return res.ok ? { ok: true, avatarUrl: j.avatarUrl } : { ok: false, error: j.error };
}

// --- Social graph (follow / block) -----------------------------------------
export interface FollowCounts {
  followers: number;
  following: number;
}
export interface Relationship {
  following: boolean; // me → them
  followedBy: boolean; // them → me
  mutual: boolean; // friends
  blocking: boolean; // I blocked them
  blockedBy: boolean; // they blocked me
  requested: boolean; // I have a pending follow request to their private account
}

/** Anyone's PUBLIC profile by @handle (no email/connections). Null if no such handle. */
export interface PublicProfile {
  handle: string;
  displayName: string | null;
  avatar: string | null;
  bio: string | null;
  memberSince: number | null;
  topTracks: TopTrack[];
  counts: FollowCounts;
  live: boolean; // broadcasting a public room right now?
  liveListeners: number;
  online: boolean; // any session open (reachable for a friend's jam knock), even if private
  private: boolean; // unlisted account → follow requires approval; content is follower-only
  isSelf: boolean;
  relationship: Relationship | null; // null when signed out or viewing self
}
export async function fetchPublicProfile(handle: string, signal?: AbortSignal): Promise<PublicProfile | null> {
  const res = await fetch(`/api/u/${encodeURIComponent(handle)}`, { signal, credentials: "same-origin" });
  if (!res.ok) return null;
  return (await res.json()) as PublicProfile;
}

type GraphAction = "follow" | "unfollow" | "block" | "unblock";
async function graphAction(
  action: GraphAction,
  handle: string,
): Promise<{ relationship: Relationship; counts: FollowCounts } | null> {
  const res = await fetch(`/api/${action}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  if (!res.ok) return null;
  return (await res.json()) as { relationship: Relationship; counts: FollowCounts };
}
export const follow = (handle: string) => graphAction("follow", handle);
export const unfollow = (handle: string) => graphAction("unfollow", handle);
export const block = (handle: string) => graphAction("block", handle);
export const unblock = (handle: string) => graphAction("unblock", handle);

// --- Live room directory (Epic E1/E2) --------------------------------------
export interface LiveRoom {
  handle: string;
  displayName: string | null;
  avatar: string | null;
  title: string | null;
  genre: string | null;
  listeners: number;
  npTitle: string | null;
  npArtist: string | null;
  startedAt: number | null;
}
/** The live public-room directory ("on now"), busiest first. Public — no auth needed. */
export async function fetchLiveRooms(signal?: AbortSignal): Promise<LiveRoom[]> {
  const res = await fetch("/api/rooms/live", { signal, credentials: "same-origin" });
  if (!res.ok) return [];
  return ((await res.json()) as { rooms: LiveRoom[] }).rooms;
}

/** A durable notification event (the bell's "Recent" feed — new follower, …). The actor is
 *  resolved server-side to a fresh card. `kind` is open-ended for forward-compat. */
export interface NotifEvent {
  id: number;
  kind: string;
  createdAt: number;
  actor: { handle: string | null; displayName: string | null; avatar: string | null };
  payload: string | null;
  followsBack: boolean; // recipient already follows the actor → show "✓ Following" instead of "Follow back"
}
export interface NotificationsPayload {
  rooms: LiveRoom[]; // people you follow who are live right now
  events: NotifEvent[]; // the durable feed
  seenAt: number; // read cursor — anything newer is "unread"
}
/** The notification bell payload (authed). Empty for a signed-out viewer. */
export async function fetchNotifications(signal?: AbortSignal): Promise<NotificationsPayload> {
  const res = await fetch("/api/me/notifications", { signal, credentials: "same-origin" });
  if (!res.ok) return { rooms: [], events: [], seenAt: 0 };
  return (await res.json()) as NotificationsPayload;
}
/** Stamp the read cursor (clears the unread badge across the account's devices). */
export async function markNotificationsSeen(): Promise<number> {
  const res = await fetch("/api/me/notifications/seen", { method: "POST", credentials: "same-origin" });
  if (!res.ok) return Date.now();
  return ((await res.json()) as { seenAt: number }).seenAt;
}

/** An ACTIONABLE person card: public identity PLUS the viewer-relative state every people row
 * needs to render a presence dot and the right inline action (Follow / Knock / Invite / Join)
 * without a second fetch. Mirrors the server's PersonCard (server/db/social.ts). */
export interface PersonCard {
  handle: string | null;
  displayName: string | null;
  avatar: string | null;
  online: boolean; // reachable for a jam knock
  live: boolean; // broadcasting right now
  following: boolean; // me → them
  followsYou: boolean; // them → me
  isSelf: boolean; // this row is me → no self-action
}
/** Back-compat alias — older call sites typed list rows as FollowCard. */
export type FollowCard = PersonCard;

/** One page of a paginated people list. `more` = a full page came back, so another may follow. */
export interface PersonPage {
  list: PersonCard[];
  more: boolean;
}
async function personPage(url: string, signal?: AbortSignal): Promise<PersonPage> {
  const res = await fetch(url, { signal, credentials: "same-origin" });
  if (!res.ok) return { list: [], more: false };
  const j = (await res.json()) as Partial<PersonPage>;
  return { list: j.list ?? [], more: !!j.more };
}

/** Who a given @handle follows — enriched, paginated. `offset` pages by 50. */
export function fetchFollowing(handle: string, offset = 0, signal?: AbortSignal): Promise<PersonPage> {
  return personPage(`/api/following?h=${encodeURIComponent(handle)}&offset=${offset}`, signal);
}
/** Who follows a given @handle — the other half of the graph. Enriched, paginated. */
export function fetchFollowers(handle: string, offset = 0, signal?: AbortSignal): Promise<PersonPage> {
  return personPage(`/api/followers?h=${encodeURIComponent(handle)}&offset=${offset}`, signal);
}

/** Global people search by @handle or display name (≥2 chars), enriched + paginated. Backs the
 * Discover search box — the directory door that works even when nobody's live. */
export function searchUsers(q: string, offset = 0, signal?: AbortSignal): Promise<PersonPage> {
  const term = q.trim();
  if (term.length < 2) return Promise.resolve({ list: [], more: false });
  return personPage(`/api/users/search?q=${encodeURIComponent(term)}&offset=${offset}`, signal);
}

/** "People you may know" — friends-of-friends (signed-in) or popular accounts (cold start). */
export async function fetchSuggested(signal?: AbortSignal): Promise<PersonCard[]> {
  const res = await fetch("/api/users/suggested", { signal, credentials: "same-origin" });
  if (!res.ok) return [];
  return ((await res.json()) as { list: PersonCard[] }).list;
}

/** A friend (mutual follow) who's online right now. `live` = broadcasting. */
export interface FriendPresence {
  handle: string;
  displayName: string | null;
  avatar: string | null;
  live: boolean;
}
/** Friends online now (authed; mutual-follow + presence). Drives Discover's "Friends online". */
export async function fetchFriendsOnline(signal?: AbortSignal): Promise<FriendPresence[]> {
  const res = await fetch("/api/me/friends-online", { signal, credentials: "same-origin" });
  if (!res.ok) return [];
  return ((await res.json()) as { friends: FriendPresence[] }).friends;
}
/** Pending incoming follow requests (to your private account) + the count for a badge. */
export async function fetchFollowRequests(signal?: AbortSignal): Promise<{ list: PersonCard[]; count: number }> {
  const res = await fetch("/api/me/follow-requests", { signal, credentials: "same-origin" });
  if (!res.ok) return { list: [], count: 0 };
  const j = (await res.json()) as { list?: PersonCard[]; count?: number };
  return { list: j.list ?? [], count: j.count ?? 0 };
}
/** Approve or deny a pending follow request from `handle`. Returns the remaining request count. */
export async function respondFollowRequest(handle: string, approve: boolean): Promise<number> {
  const res = await fetch(`/api/follow/${approve ? "approve" : "deny"}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  if (!res.ok) return -1;
  return ((await res.json()) as { count?: number }).count ?? 0;
}

/** Push-invite a friend (by @handle) to jam — they get a bell event with a one-tap Join. */
export async function sendInvite(toHandle: string): Promise<boolean> {
  const res = await fetch("/api/invite", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toHandle: toHandle.replace(/^@/, "") }),
  });
  return res.ok;
}

export interface RoomAnnounce {
  title?: string;
  genre?: string;
  // NOTE: the listener count is NOT sent — the server reads it authoritatively from the room
  // DO (L4 anti-sybil), so a client number would just be ignored.
  nowPlaying?: { title?: string; artist?: string; videoId?: string };
}
/** HOST: announce/heartbeat the live room into the directory (call on go-public + periodically). */
export async function announceRoom(a: RoomAnnounce): Promise<boolean> {
  const res = await fetch("/api/rooms/announce", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(a),
  });
  return res.ok;
}
/** HOST: drop the live room from the directory (stopped broadcasting). */
export async function closeRoom(): Promise<void> {
  await fetch("/api/rooms/close", { method: "POST", credentials: "same-origin" });
}

// --- Recorded sets (Epic G1) -----------------------------------------------
export interface SetTrack {
  videoId: string;
  title?: string | null;
  artist?: string | null;
  at: number; // ms from set start
}
/** A recorded set's card (a row in the profile history / Discover; the heavy recipe log
 *  lives in R2 and is fetched only at replay, G1c). Host identity fields ride public lists. */
export interface SetCard {
  id: string;
  handle?: string | null;
  displayName?: string | null;
  avatar?: string | null;
  title: string | null;
  genre: string | null;
  status: "draft" | "published";
  duration: number; // ms
  tracks: number;
  tracklist: SetTrack[];
  coverVideo: string | null;
  engineVer: number;
  createdAt: number;
  publishedAt: number | null;
  trimStart?: number | null; // ms — curated performance in-point (null = recording start)
  trimEnd?: number | null; // ms — curated performance out-point (null = recording end)
}

/** HOST: persist a just-captured broadcast recipe as a private draft (capture-by-default,
 *  G1a). Best-effort — a failed save just means no recording, never a broken broadcast. */
export async function saveSet(set: unknown): Promise<{ id: string } | null> {
  try {
    const res = await fetch("/api/sets", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(set),
    });
    if (!res.ok) return null;
    return (await res.json()) as { id: string };
  } catch {
    return null;
  }
}

/** The signed-in host's own sets (drafts + published), newest first — the lifecycle card
 *  (G1b) + profile history (G1d) read this. */
export async function fetchMySets(signal?: AbortSignal): Promise<SetCard[]> {
  const res = await fetch("/api/me/sets", { signal, credentials: "same-origin" });
  if (!res.ok) return [];
  return ((await res.json()) as { sets: SetCard[] }).sets;
}

/** One set by id (card + host handle) — for resolving a shared /set/:id link (G4). */
export async function fetchSet(id: string, signal?: AbortSignal): Promise<SetCard | null> {
  const res = await fetch(`/api/sets/${encodeURIComponent(id)}`, { signal, credentials: "same-origin" });
  if (!res.ok) return null;
  return ((await res.json()) as { set: SetCard }).set ?? null;
}

/** The published-sets directory for Discover (newest first, with host identity). Public. */
export async function fetchDiscoverSets(signal?: AbortSignal): Promise<SetCard[]> {
  const res = await fetch("/api/sets/discover", { signal, credentials: "same-origin" });
  if (!res.ok) return [];
  return ((await res.json()) as { sets: SetCard[] }).sets;
}

/** A @handle's PUBLISHED sets (their public profile history). Public. */
export async function fetchHandleSets(handle: string, signal?: AbortSignal): Promise<SetCard[]> {
  const res = await fetch(`/api/u/${encodeURIComponent(handle)}/sets`, { signal, credentials: "same-origin" });
  if (!res.ok) return [];
  return ((await res.json()) as { sets: SetCard[] }).sets;
}

// Set lifecycle (G1b) — owner-only mutations. Each resolves to ok; the caller refetches.
const setAction = async (id: string, action: string, body?: unknown): Promise<boolean> => {
  const res = await fetch(`/api/sets/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.ok;
};
/** Make a draft public (it shows on the profile + Discover). */
export const publishSet = (id: string) => setAction(id, "publish");
/** Pull a published set back to a private draft. */
export const unpublishSet = (id: string) => setAction(id, "unpublish");
/** Rename a set (empty → a default "Set · date" label). */
export const renameSet = (id: string, title: string) => setAction(id, "rename", { title });
/** Trim the set's performance in/out (ms; pass nulls to clear). The curated range is what plays. */
export const trimSet = (id: string, start: number | null, end: number | null) => setAction(id, "trim", { start, end });
/** Discard a set — deletes the row + the R2 recipe blob. */
export async function discardSet(id: string): Promise<boolean> {
  const res = await fetch(`/api/sets/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "same-origin" });
  return res.ok;
}

/** File a moderation report (L2) — a room, a chat line, or a user. Lands in the admin queue. */
export async function fileReport(r: { kind: "room" | "chat" | "user"; room?: string; dev?: string; text?: string; reason?: string }): Promise<boolean> {
  try {
    const res = await fetch("/api/report", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(r),
    });
    return res.ok;
  } catch {
    return false;
  }
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
