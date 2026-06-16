// DEV-ONLY file-backed store that stands in for the production D1 (server/db.ts) so the
// single-user account surface — sign-in, profile, settings sync, lyrics pool — works under
// plain `pnpm dev` (Vite middleware) without a Worker, D1, or Google OAuth. Everything lives
// as JSON under .dev-data/ (gitignored). There is exactly ONE dev user; no multi-tenancy,
// no auth beyond a presence cookie. NEVER import this from the Worker — see server/api.ts.

import { promises as fs } from "node:fs";
import path from "node:path";
import { HANDLE_RENAME_COOLDOWN_MS } from "./security";

const DIR = path.resolve(".dev-data");
const USER_FILE = path.join(DIR, "user.json");
const SETTINGS_FILE = path.join(DIR, "settings.json");
const PLAYS_FILE = path.join(DIR, "plays.json");
const ROOM_FILE = path.join(DIR, "room.json");
const LYRICS_DIR = path.join(DIR, "lyrics");

export interface DevUser {
  id: string;
  email: string | null;
  name: string | null; // Google-mirror seed
  avatar: string | null; // Google-mirror seed
  created_at: number; // epoch ms — backs "member since"
  // Public identity (mirrors the 0012 split in server/db.ts). One dev user, so a
  // handle is never "taken" by anyone else.
  handle?: string | null;
  handle_folded?: string | null;
  handle_set_at?: number | null;
  display_name?: string | null;
  avatar_url?: string | null;
  bio?: string | null;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, obj: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj, null, 2));
}

// The one dev user. Persisted on first touch so "member since" is stable across reloads.
export async function devUser(): Promise<DevUser> {
  const existing = await readJson<DevUser | null>(USER_FILE, null);
  if (existing) return existing;
  const user: DevUser = {
    id: "dev-user",
    email: "dev@localhost",
    name: "Dev User",
    avatar: null,
    created_at: Date.now(),
  };
  await writeJson(USER_FILE, user);
  return user;
}

// --- public identity: handle + profile (mirrors setUserHandle/updateProfile) -----------
// Single dev user → no other account can hold a handle, so it's always "available"
// once it passes validation (done by the caller via security.validateHandle).
export async function handleTaken(_folded: string): Promise<boolean> {
  return false;
}
export async function setHandle(handle: string, folded: string): Promise<{ ok: boolean; reason?: string }> {
  const u = await devUser();
  if (u.handle && u.handle_set_at) {
    const remaining = HANDLE_RENAME_COOLDOWN_MS - (Date.now() - u.handle_set_at);
    if (remaining > 0) {
      const days = Math.ceil(remaining / 86_400_000);
      return { ok: false, reason: `you can change your handle again in ${days} day${days === 1 ? "" : "s"}` };
    }
  }
  u.handle = handle;
  u.handle_folded = folded;
  u.handle_set_at = Date.now();
  await writeJson(USER_FILE, u);
  return { ok: true };
}
export async function updateProfile(f: {
  display_name?: string | null;
  bio?: string | null;
  avatar_url?: string | null;
}): Promise<void> {
  const u = await devUser();
  if (f.display_name !== undefined) u.display_name = f.display_name;
  if (f.bio !== undefined) u.bio = f.bio;
  if (f.avatar_url !== undefined) u.avatar_url = f.avatar_url;
  await writeJson(USER_FILE, u);
}

// --- settings blob (mirrors getUserSettings / putUserSettings, server/db.ts) -----------
export async function getSettings(): Promise<{ data: unknown; updated_at: number } | null> {
  return readJson<{ data: unknown; updated_at: number } | null>(SETTINGS_FILE, null);
}
export async function putSettings(data: unknown, updatedAt: number): Promise<void> {
  await writeJson(SETTINGS_FILE, { data, updated_at: updatedAt });
}

// --- play stats (mirrors logUserPlay / getTopTracks, server/db.ts) ---------------------
interface PlayRow {
  videoId: string;
  title: string;
  artist: string;
  thumbnail: string | null;
  plays: number;
  last_played_at: number;
}
export interface DevTopTrack {
  videoId: string;
  title: string;
  artist: string;
  thumbnail: string | null;
  plays: number;
}

export async function logPlay(t: {
  videoId: string;
  title?: string;
  artist?: string;
  thumbnail?: string | null;
}): Promise<void> {
  const rows = await readJson<Record<string, PlayRow>>(PLAYS_FILE, {});
  const prev = rows[t.videoId];
  rows[t.videoId] = {
    videoId: t.videoId,
    title: t.title ?? prev?.title ?? "",
    artist: t.artist ?? prev?.artist ?? "",
    thumbnail: t.thumbnail ?? prev?.thumbnail ?? null,
    plays: (prev?.plays ?? 0) + 1,
    last_played_at: Date.now(),
  };
  await writeJson(PLAYS_FILE, rows);
}

export async function topTracks(limit = 12): Promise<DevTopTrack[]> {
  const rows = await readJson<Record<string, PlayRow>>(PLAYS_FILE, {});
  return Object.values(rows)
    .sort((a, b) => b.plays - a.plays || b.last_played_at - a.last_played_at)
    .slice(0, limit)
    .map((r) => ({ videoId: r.videoId, title: r.title, artist: r.artist, thumbnail: r.thumbnail, plays: r.plays }));
}

// --- room registry (mirrors announceRoom / closeRoom / liveRooms, server/db.ts) --------
interface DevRoom {
  live: boolean;
  title: string | null;
  genre: string | null;
  listeners: number;
  npTitle: string | null;
  npArtist: string | null;
  startedAt: number | null;
  lastSeen: number;
}
export async function announceRoom(a: {
  title?: string | null;
  genre?: string | null;
  listeners?: number;
  npTitle?: string | null;
  npArtist?: string | null;
}): Promise<void> {
  const prev = await readJson<DevRoom | null>(ROOM_FILE, null);
  await writeJson(ROOM_FILE, {
    live: true,
    title: a.title ?? null,
    genre: a.genre ?? null,
    listeners: a.listeners ?? 0,
    npTitle: a.npTitle ?? null,
    npArtist: a.npArtist ?? null,
    startedAt: prev?.live ? (prev.startedAt ?? Date.now()) : Date.now(),
    lastSeen: Date.now(),
  } satisfies DevRoom);
}
export async function closeRoom(): Promise<void> {
  const prev = await readJson<DevRoom | null>(ROOM_FILE, null);
  if (prev) await writeJson(ROOM_FILE, { ...prev, live: false, startedAt: null });
}
export async function liveRooms(): Promise<unknown[]> {
  const r = await readJson<DevRoom | null>(ROOM_FILE, null);
  const u = await devUser();
  if (!r || !r.live || !u.handle || Date.now() - r.lastSeen > 90_000) return [];
  return [
    {
      handle: u.handle,
      displayName: u.display_name ?? null,
      avatar: u.avatar_url ?? null,
      title: r.title,
      genre: r.genre,
      listeners: r.listeners,
      npTitle: r.npTitle,
      npArtist: r.npArtist,
      startedAt: r.startedAt,
    },
  ];
}

// --- lyrics pool (mirrors getLyrics / putLyrics, one file per video) -------------------
export interface DevLyricsRow {
  model: string;
  lang: string;
  conf: number;
  lines: unknown;
}
export async function getLyrics(videoId: string): Promise<DevLyricsRow | null> {
  return readJson<DevLyricsRow | null>(path.join(LYRICS_DIR, `${videoId}.json`), null);
}
export async function putLyrics(videoId: string, row: DevLyricsRow): Promise<void> {
  await writeJson(path.join(LYRICS_DIR, `${videoId}.json`), row);
}
