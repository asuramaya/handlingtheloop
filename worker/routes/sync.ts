// Two-phase cross-service playlist sync (review before commit). All require an htl session;
// matching uses the free innertube search. Split verbatim out of the old index.ts switch.
import { type Env, MAX_MATCH_TRACKS, json, searchYouTube, sessionUser } from "../shared";
import {
  type Service,
  type SourceTrack,
  addToDestPlaylist,
  createDestPlaylist,
  matchTracks,
  readSource,
  searchDest,
} from "../../server/sync";

export async function handleSyncRoutes(url: URL, req: Request, env: Env): Promise<Response | null> {
  switch (url.pathname) {
    case "/api/sync/source": {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      const user = await sessionUser(req, env);
      if (!user) return json(401, { error: "sign in first" });
      const b = (await req.json().catch(() => ({}))) as { source?: Service; sourcePlaylistId?: string };
      if (!b.source || !b.sourcePlaylistId) return json(400, { error: "missing source or sourcePlaylistId" });
      return json(200, await readSource(env, user.id, b.source, b.sourcePlaylistId));
    }
    case "/api/sync/match": {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      const user = await sessionUser(req, env);
      if (!user) return json(401, { error: "sign in first" });
      const b = (await req.json().catch(() => ({}))) as {
        dest?: Service;
        tracks?: SourceTrack[];
        startIndex?: number;
      };
      if (!b.dest || !Array.isArray(b.tracks)) return json(400, { error: "missing dest or tracks" });
      // Each track drives a YouTube search subrequest — cap the batch so a single
      // call can't blow the Worker subrequest limit / fan out abusively.
      if (b.tracks.length > MAX_MATCH_TRACKS) return json(413, { error: `too many tracks (max ${MAX_MATCH_TRACKS} per call)` });
      return json(200, { rows: await matchTracks(env, user.id, b.dest, b.tracks, b.startIndex ?? 0, { searchYouTube }) });
    }
    case "/api/sync/search": {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      const user = await sessionUser(req, env);
      if (!user) return json(401, { error: "sign in first" });
      const b = (await req.json().catch(() => ({}))) as { dest?: Service; query?: string };
      if (!b.dest || !b.query?.trim()) return json(400, { error: "missing dest or query" });
      return json(200, { candidates: await searchDest(env, user.id, b.dest, b.query.trim(), { searchYouTube }) });
    }
    case "/api/sync/create": {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      const user = await sessionUser(req, env);
      if (!user) return json(401, { error: "sign in first" });
      const b = (await req.json().catch(() => ({}))) as { dest?: Service; name?: string };
      if (!b.dest || !b.name) return json(400, { error: "missing dest or name" });
      return json(200, await createDestPlaylist(env, user.id, b.dest, b.name));
    }
    case "/api/sync/add": {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      const user = await sessionUser(req, env);
      if (!user) return json(401, { error: "sign in first" });
      const b = (await req.json().catch(() => ({}))) as { dest?: Service; playlistId?: string; ids?: string[] };
      if (!b.dest || !b.playlistId || !Array.isArray(b.ids)) {
        return json(400, { error: "missing dest, playlistId, or ids" });
      }
      return json(200, { added: await addToDestPlaylist(env, user.id, b.dest, b.playlistId, b.ids) });
    }
    default:
      return null;
  }
}
