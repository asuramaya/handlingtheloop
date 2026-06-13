// DEV-ONLY file-backed store that stands in for the production D1 (server/db.ts) so the
// single-user account surface — sign-in, profile, settings sync, lyrics pool — works under
// plain `pnpm dev` (Vite middleware) without a Worker, D1, or Google OAuth. Everything lives
// as JSON under .dev-data/ (gitignored). There is exactly ONE dev user; no multi-tenancy,
// no auth beyond a presence cookie. NEVER import this from the Worker — see server/api.ts.

import { promises as fs } from "node:fs";
import path from "node:path";

const DIR = path.resolve(".dev-data");
const USER_FILE = path.join(DIR, "user.json");
const SETTINGS_FILE = path.join(DIR, "settings.json");
const PLAYS_FILE = path.join(DIR, "plays.json");
const LYRICS_DIR = path.join(DIR, "lyrics");

export interface DevUser {
  id: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
  created_at: number; // epoch ms — backs "member since"
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
