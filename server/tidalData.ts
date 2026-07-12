// TIDAL Web API v2 (openapi.tidal.com/v2) reads/writes for the sync feature,
// authenticated by a Bearer token (resolved via connections.ts). The v2 API is
// JSON:API — resources are `{ type, id, attributes, relationships }`, and related
// resources (a track's artists/album) ride in a top-level `included[]` array that
// you join by (type,id). We centralize that join in `parseTracks`.
//
// ⚠ ENDPOINTS TO VERIFY: TIDAL's v2 paths/filters are documented behind a JS API
// explorer we couldn't scrape, so the exact paths + filter params below are a
// best-effort read of the JSON:API conventions and should be confirmed against a
// live key (the whole provider is env-gated off until then). Auth + the JSON:API
// shape are solid; the specific filter/relationship names are the risk surface.
import type { MyPlaylist } from "./innertube";
import type { TrackMeta } from "./youtube";
import type { Candidate } from "./match";

const API = "https://openapi.tidal.com/v2";
const TIMEOUT_MS = 8000;
const JSONAPI = "application/vnd.api+json";

// TIDAL catalog endpoints are region-scoped. We don't know the user's storefront
// here, so default to US; a wrong country mostly affects availability, not identity.
const COUNTRY = "US";

interface JsonApiResource {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { type: string; id: string } | { type: string; id: string }[] }>;
}
interface JsonApiDoc {
  data?: JsonApiResource | JsonApiResource[];
  included?: JsonApiResource[];
  links?: { next?: string | null };
}

async function tget(urlOrPath: string, token: string): Promise<JsonApiDoc> {
  const url = urlOrPath.startsWith("http") ? urlOrPath : `${API}${urlOrPath}`;
  // Only follow TIDAL's own pagination links — never send the Bearer elsewhere.
  if (new URL(url).host !== "openapi.tidal.com") throw new Error("refusing non-TIDAL URL");
  // TIDAL throttles hard: paging a large playlist's items (60+ pages, e.g. a 1200-track
  // list) trips 429. Back off and retry (honoring Retry-After) so big playlists import
  // instead of dying on the first throttle. Capped attempts/wait keep the Worker request bounded.
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: JSONAPI },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if ((res.status !== 429 && res.status !== 503) || attempt >= 4) break;
    const ra = Number(res.headers.get("retry-after"));
    const waitMs = Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt, 4000);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  const text = await res.text();
  let j: JsonApiDoc = {};
  try {
    j = text ? (JSON.parse(text) as JsonApiDoc) : {};
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const endpoint = urlOrPath.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const errs = (j as unknown as { errors?: { detail?: string }[] }).errors;
    const msg = errs?.[0]?.detail || text.slice(0, 160);
    throw new Error(`tidal ${res.status}${msg ? `: ${msg}` : ""} [${endpoint}]`);
  }
  return j;
}

async function tpost(path: string, token: string, body: unknown): Promise<JsonApiDoc> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": JSONAPI, accept: JSONAPI },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let j: JsonApiDoc = {};
  try {
    j = text ? (JSON.parse(text) as JsonApiDoc) : {};
  } catch {
    /* may be 201 with empty body */
  }
  if (!res.ok) {
    const errs = (j as unknown as { errors?: { detail?: string }[] }).errors;
    throw new Error(`tidal ${res.status}${errs?.[0]?.detail ? `: ${errs[0].detail}` : ""} [${path}]`);
  }
  return j;
}

// ISO-8601 duration ("PT3M44S") → seconds. TIDAL v2 reports track length this way.
function parseISODuration(iso?: unknown): number {
  if (typeof iso === "number") return Math.round(iso);
  if (typeof iso !== "string") return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return Number(iso) || 0;
  return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}

const asArray = (d: JsonApiDoc["data"]): JsonApiResource[] => (Array.isArray(d) ? d : d ? [d] : []);

// Join a track resource to its artists/album via the document's `included[]`.
function trackFromResource(t: JsonApiResource, included: Map<string, JsonApiResource>): TidalTrack {
  const a = t.attributes ?? {};
  const artistRefs = t.relationships?.artists?.data;
  const artistList = Array.isArray(artistRefs) ? artistRefs : artistRefs ? [artistRefs] : [];
  const artist = artistList
    .map((r) => included.get(`${r.type}:${r.id}`)?.attributes?.title ?? included.get(`${r.type}:${r.id}`)?.attributes?.name)
    .filter(Boolean)
    .join(", ");
  // Album cover: relationship → album resource → its imageLinks. Best-effort.
  const albumRef = t.relationships?.albums?.data;
  const album = albumRef ? included.get(`${(Array.isArray(albumRef) ? albumRef[0] : albumRef).type}:${(Array.isArray(albumRef) ? albumRef[0] : albumRef).id}`) : undefined;
  const imageLinks = (album?.attributes?.imageLinks ?? a.imageLinks) as { href?: string }[] | undefined;
  return {
    videoId: "",
    title: (a.title as string) || "",
    artist: artist || (a.artist as string) || "",
    duration: parseISODuration(a.duration),
    thumbnail: imageLinks?.[0]?.href ?? null,
    views: null,
    isrc: (a.isrc as string) ?? null,
    tidalId: t.id,
  };
}

export interface MyTidalPlaylist {
  id: string;
  name?: string;
}

// Map a playlist JSON:API resource → our MyPlaylist row.
function playlistRow(p: JsonApiResource): MyPlaylist {
  const a = p.attributes ?? {};
  return {
    id: p.id,
    title: (a.name as string) || (a.title as string) || "Playlist",
    count: (a.numberOfItems as number) ?? 0,
    thumbnail: (a.imageLinks as { href?: string }[] | undefined)?.[0]?.href ?? null,
  };
}

/** The signed-in user's own playlists. `userId` is the stored provider_user_id.
 *  ⚠ TIDAL exposes a user's playlists through their COLLECTION; we read the
 *  collection→playlists relationship with the playlist resources sideloaded. If a
 *  live key 404s this, the alternative is `GET /playlists?filter[owners.id]=…` —
 *  the diagnostic error names the failing path. */
export async function getMyTidalPlaylists(token: string, userId: string): Promise<MyPlaylist[]> {
  const out: MyPlaylist[] = [];
  const seen = new Set<string>();
  let url: string | null = `/userCollections/${encodeURIComponent(userId)}/relationships/playlists?include=playlists&countryCode=${COUNTRY}`;
  let guard = 0;
  while (url && guard++ < 30) {
    const j = await tget(url, token);
    // Playlist resources may arrive inline in `data` (with attributes) or sideloaded
    // in `included`; collect from both so we're robust to either shape.
    const candidates = [...asArray(j.data), ...(j.included ?? [])];
    for (const p of candidates) {
      if (p.type !== "playlists" || !p.attributes || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(playlistRow(p));
    }
    url = j.links?.next ?? null;
  }
  return out;
}

/** Best candidate matches for a query (the sync destination = TIDAL). */
export async function searchTidalTracks(token: string, query: string, limit = 5): Promise<Candidate[]> {
  // JSON:API search: the result document includes the matched track resources.
  const j = await tget(
    `/searchResults/${encodeURIComponent(query)}?countryCode=${COUNTRY}&include=tracks`,
    token,
  );
  const included = new Map<string, JsonApiResource>();
  for (const r of j.included ?? []) included.set(`${r.type}:${r.id}`, r);
  const tracks = (j.included ?? []).filter((r) => r.type === "tracks").slice(0, limit);
  return tracks.map((t) => {
    const tr = trackFromResource(t, included);
    return {
      id: t.id, // TIDAL track id — what addTidalTracks() appends
      kind: "uri" as const,
      title: tr.title,
      artist: tr.artist,
      duration: tr.duration,
      thumbnail: tr.thumbnail,
    };
  });
}

export interface TidalTrack extends TrackMeta {
  isrc: string | null;
  tidalId: string | null;
}

/** A playlist's tracks (paginated), normalized + ISRC-tagged for cross-matching. `truncated` is true
 *  when the page guard tripped before the list was exhausted — the caller must NOT treat the result
 *  as the complete playlist (e.g. re-sync must not prune the unread tail). */
export async function getTidalPlaylistTracks(token: string, playlistId: string): Promise<{ tracks: TidalTrack[]; truncated: boolean }> {
  const out: TidalTrack[] = [];
  // JSON:API relationship traversal: the playlist's items, with the track resources
  // sideloaded via `include=items`.
  let url: string | null = `/playlists/${encodeURIComponent(playlistId)}/relationships/items?include=items&countryCode=${COUNTRY}`;
  let guard = 0;
  while (url && guard++ < 60) {
    const j = await tget(url, token);
    const included = new Map<string, JsonApiResource>();
    for (const r of j.included ?? []) included.set(`${r.type}:${r.id}`, r);
    // Order follows the relationship `data[]`; pull each referenced track resource.
    for (const ref of asArray(j.data)) {
      const t = included.get(`${ref.type}:${ref.id}`) ?? (ref.attributes ? ref : undefined);
      if (!t || t.type !== "tracks") continue;
      out.push(trackFromResource(t, included));
    }
    url = j.links?.next ?? null;
  }
  return { tracks: out, truncated: url != null }; // url still set → we stopped at the guard, not the end
}

/** A playlist's display NAME — one cheap metadata call (the items relationship carries tracks, not the name). */
export async function getTidalPlaylistName(token: string, playlistId: string): Promise<string> {
  const j = await tget(`/playlists/${encodeURIComponent(playlistId)}?countryCode=${COUNTRY}`, token);
  const a = (Array.isArray(j.data) ? j.data[0] : j.data)?.attributes ?? {};
  return (a.name as string) || (a.title as string) || "";
}

/** TIDAL's "track radio" — the algorithmic next-track graph for a seed track,
 *  normalized + ISRC-tagged so the auto-mixer can match each back to a videoId.
 *  ⚠ ENDPOINT TO VERIFY (see header): the v2 path for track radio/recommendations
 *  isn't confirmed against a live key. We try the JSON:API relationship traversal
 *  and fail soft (→ []) so a wrong path never breaks the recommendation merge. */
export async function getTidalTrackRadio(token: string, trackId: string, limit = 25): Promise<TidalTrack[]> {
  try {
    // VERIFIED against a live key: `similarTracks` is the track-radio relationship
    // (trackRadio 404s; `radio` returns a playlist). It returns up to ~40 track refs
    // with the resources sideloaded in `included[]`.
    // Nested include pulls each similar track's artist resources too, so we get a
    // real "artist — title" to resolve against YouTube (not just the title).
    const j = await tget(
      `/tracks/${encodeURIComponent(trackId)}/relationships/similarTracks?include=similarTracks.artists&countryCode=${COUNTRY}`,
      token,
    );
    const included = new Map<string, JsonApiResource>();
    for (const r of j.included ?? []) included.set(`${r.type}:${r.id}`, r);
    const out: TidalTrack[] = [];
    // Order follows the relationship data[]; resolve each referenced track resource.
    for (const ref of asArray(j.data)) {
      const t = included.get(`${ref.type}:${ref.id}`) ?? (ref.attributes ? ref : undefined);
      if (!t || t.type !== "tracks") continue;
      out.push(trackFromResource(t, included));
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return []; // endpoint unverified / unavailable — caller falls back to YouTube
  }
}

/** Find a TIDAL track id for an ISRC (to seed track-radio from a non-TIDAL track). */
export async function tidalTrackIdByIsrc(token: string, isrc: string): Promise<string | null> {
  try {
    const j = await tget(`/tracks?filter[isrc]=${encodeURIComponent(isrc.toUpperCase())}&countryCode=${COUNTRY}`, token);
    return asArray(j.data).find((r) => r.type === "tracks")?.id ?? null;
  } catch {
    return null;
  }
}

/** Diagnostic: hit the candidate ISRC-filter + track-radio endpoints raw and report
 *  HTTP status + result count for each, so we can confirm which v2 path actually
 *  works against a live key (the radio endpoint is otherwise unverified). */
export async function tidalProbe(token: string, opts: { isrc?: string | null; query?: string | null }) {
  const raw = async (path: string) => {
    try {
      const res = await fetch(`${API}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: JSONAPI },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      let count: number | null = null;
      let trackId: string | null = null;
      try {
        const j = JSON.parse(text) as JsonApiDoc;
        const arr = asArray(j.data);
        count = arr.length + (j.included?.length ?? 0);
        // The seed track id may be: a track in data[] (ISRC filter), the nested
        // searchResults→tracks relationship, or a sideloaded included[] track.
        const dataObj = Array.isArray(j.data) ? undefined : (j.data as JsonApiResource | undefined);
        trackId =
          arr.find((r) => r.type === "tracks")?.id ??
          (dataObj?.relationships?.tracks?.data as { id?: string }[] | undefined)?.[0]?.id ??
          j.included?.find((r) => r.type === "tracks")?.id ??
          null;
      } catch {
        /* non-JSON */
      }
      return { path, status: res.status, count, trackId, sample: text.slice(0, 200) };
    } catch (e) {
      return { path, status: 0, error: (e as Error).message };
    }
  };

  // Resolve a seed track id either by ISRC filter, or by searching a free-text query.
  let id: string | null = null;
  let seed: Record<string, unknown> = {};
  if (opts.isrc) {
    const code = opts.isrc.trim().toUpperCase();
    const byIsrc = await raw(`/tracks?filter[isrc]=${encodeURIComponent(code)}&countryCode=${COUNTRY}`);
    id = byIsrc.trackId ?? null;
    seed = { isrc: code, trackLookup: byIsrc };
  } else if (opts.query) {
    const search = await raw(`/searchResults/${encodeURIComponent(opts.query)}?countryCode=${COUNTRY}&include=tracks`);
    id = search.trackId ?? null;
    seed = { query: opts.query, searchLookup: search };
  }

  const radios = id ? await raw(`/tracks/${id}/relationships/similarTracks?include=similarTracks&countryCode=${COUNTRY}`) : null;
  // End-to-end check: what getTidalTrackRadio actually parses out (title/artist/isrc).
  const parsed = id ? (await getTidalTrackRadio(token, id, 5)) : [];
  return { ...seed, resolvedTrackId: id, similarTracks: radios, parsedSample: parsed };
}

/** Create a private playlist under the user, returning its id. */
export async function createTidalPlaylist(token: string, name: string, description = ""): Promise<string> {
  const j = await tpost(`/playlists?countryCode=${COUNTRY}`, token, {
    data: { type: "playlists", attributes: { name, description, accessType: "UNLISTED" } },
  });
  const id = (Array.isArray(j.data) ? j.data[0] : j.data)?.id;
  if (!id) throw new Error("TIDAL playlist create returned no id");
  return id;
}

/** Append track ids to a playlist (JSON:API relationship POST). */
export async function addTidalTracks(token: string, playlistId: string, trackIds: string[]): Promise<void> {
  // Chunk conservatively; the relationship POST takes a `data[]` of track refs.
  for (let i = 0; i < trackIds.length; i += 50) {
    await tpost(`/playlists/${encodeURIComponent(playlistId)}/relationships/items?countryCode=${COUNTRY}`, token, {
      data: trackIds.slice(i, i + 50).map((id) => ({ type: "tracks", id })),
    });
  }
}
