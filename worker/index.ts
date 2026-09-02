// Cloudflare Worker entry. The whole backend: pure JS, no binaries, no extra services.
// Serves the built SPA (env.ASSETS) and the /api/* routes. The shared scaffolding (Env, the
// hand-rolled CF type interfaces, helpers, innertube singletons) lives in ./shared; the /api/*
// route bodies are grouped under ./routes/*. This file keeps only the request entry point, the
// WebSocket session upgrade, the OpenGraph unfurl, the DO→Worker internal bridges, and the
// dispatcher that chains the route groups.
import { type Env, type ExecutionContext, json, sessionUser } from "./shared";
import { handleAudioRoutes } from "./routes/audio";
import { handleCatalogRoutes } from "./routes/catalog";
import { handleCommunityRoutes } from "./routes/community";
import { handleSyncRoutes } from "./routes/sync";
import { handleReportRoutes } from "./routes/report";
import { handleAuthRoutes } from "./routes/auth";
import { handleAccountRoute } from "../server/accounts";
import { handleSampleRoute } from "../server/samples";
import {
  isFollowing,
  blockedEither,
  addNotification,
  setPresenceOnline,
  setPresenceOffline,
  consumeSessionInvite,
  relationship,
  inviteOwner,
  ensureIdentityColumns,
  userByHandle,
  liveRoomStatus,
  ensureSetsTable,
  getSet,
} from "../server/db";
import { SECURITY_HEADERS, foldHandle } from "../server/security";

async function handleApi(url: URL, req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { allow: "GET, POST, PUT, OPTIONS" } });
  }
  try {
    // SaaS account / connected-service routes (D1-backed) get first refusal.
    const accountRes = await handleAccountRoute(url, req, env);
    if (accountRes) return accountRes;

    // Sampler global-pad clips (D1 index + R2 bytes), account-gated. Null when not its path.
    const sampleRes = await handleSampleRoute(url, req, env);
    if (sampleRes) return sampleRes;

    // /api/* route groups — each returns a Response for its own paths, else null. Order is
    // irrelevant (exact-pathname match), so this is just a flat chain; the first hit wins.
    const res =
      (await handleAudioRoutes(url, req, env, ctx)) ??
      (await handleCatalogRoutes(url, req, env, ctx)) ??
      (await handleCommunityRoutes(url, req, env, ctx)) ??
      (await handleSyncRoutes(url, req, env)) ??
      (await handleReportRoutes(url, req, env)) ??
      (await handleAuthRoutes(url, req, env));
    if (res) return res;

    // NOTE: reindex + takedown are privileged moderation ops and live ONLY in the
    // Access-gated admin worker (admin.handlingtheloop.com / server/admin.ts).
    return json(404, { error: `unknown endpoint ${url.pathname}` });
  } catch (e) {
    const msg = (e as Error).message;
    // Writing TO YouTube needs the manage scope the user may not have granted at
    // read-only sign-in. Surface it as an actionable 403 so the client can send them
    // through incremental auth (/api/auth/google/start?write=1) and retry, instead of
    // a dead-end 502 with a cryptic body.
    if (msg === "youtube_write_required") return json(403, { error: "youtube_write_required", needsWrite: true });
    return json(502, { error: msg });
  }
}

// Shared-session WebSocket upgrade. Authed by the htl_session cookie (rides along
// same-origin), then routed to the per-account DjRoom DO. Kept out of handleApi so
// the 101 upgrade response passes through untouched (no JSON wrapping). The DO
// itself never sees credentials or audio — only control intents + track ids.
async function handleRoom(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json(426, { error: "expected a websocket upgrade" });
  }
  // Defense-in-depth against cross-site WebSocket hijacking. SameSite=Lax already
  // keeps the session cookie off cross-site handshakes, but also reject a mismatched
  // Origin outright. Allowlist defaults to this request's own origin; override via
  // WS_ALLOWED_ORIGINS (comma-separated) if the app is ever embedded elsewhere.
  const origin = req.headers.get("Origin");
  if (origin) {
    const allowed = (env.WS_ALLOWED_ORIGINS || new URL(req.url).origin)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!allowed.includes(origin)) return json(403, { error: "origin not allowed" });
  }
  if (!env.ROOM) return json(503, { error: "shared sessions are not configured" });
  const user = await sessionUser(req, env);

  // Which session? Signed-in users land in their OWN session by default (devices group),
  // or in a HOST's session when they open an invite code. ANONYMOUS users may join too,
  // but ONLY via a valid invite code (they can't own a session). The session key is
  // derived server-side, so a raw user id never appears in a URL.
  const url = new URL(req.url);
  const roomHandle = (url.searchParams.get("room") || "").trim(); // public listen by @handle (broadcast plane)
  const jamHandle = (url.searchParams.get("jam") || "").trim(); // PARTICIPATE by @handle (friend co-play)
  const code = (url.searchParams.get("join") || "").trim();
  let hostId: string | null = user ? user.id : null;
  // PUBLIC listen: resolve @handle → the host's home room. Anyone (incl. anonymous) may
  // tune in; the DO admits them read-only only if the host opened the room (its `public`
  // flag). The owner opening their OWN handle stays a normal host connection (full control).
  let asPublic = false;
  let invited = false; // a push-invite grant was consumed → the DO auto-admits (no second approval)
  if (roomHandle && env.DB) {
    await ensureIdentityColumns(env.DB);
    const u = await userByHandle(env.DB, foldHandle(roomHandle));
    if (!u || !u.handle) return json(404, { error: "no such room" });
    hostId = u.id;
    asPublic = !(user && user.id === u.id);
    // Block is universal — a blocked user can't tune into the blocker's PUBLIC room either
    // (the jam branch already gates this; public-listen was the one surface that didn't).
    if (asPublic && user) {
      const rel = await relationship(env.DB, user.id, u.id);
      if (rel.blocking || rel.blockedBy) return json(403, { error: "unavailable" });
    }
  } else if (jamHandle && env.DB && user) {
    // JAM by @handle: participate in a FRIEND's session (not a public read-only listen). Gated on
    // MUTUAL follow — only friends can knock. A consumed push-invite grant auto-admits; otherwise
    // they land as a knock (the host approves). Jamming your OWN handle is just a host connection.
    await ensureIdentityColumns(env.DB);
    const u = await userByHandle(env.DB, foldHandle(jamHandle));
    if (!u || !u.handle) return json(404, { error: "no such room" });
    hostId = u.id;
    if (user.id !== u.id) {
      const rel = await relationship(env.DB, user.id, u.id);
      if (!rel.mutual || rel.blocking || rel.blockedBy) return json(403, { error: "you can only jam with friends (mutual follow)" });
      invited = await consumeSessionInvite(env.DB, u.id, user.id);
    }
  } else if (code && env.DB) {
    const owner = await inviteOwner(env.DB, code);
    if (owner) hostId = owner;
    else if (!user) return json(404, { error: "that invite link isn't valid" });
  }
  if (!hostId) return json(401, { error: "sign in, or open an invite link to join a session" });

  // Mark whether THIS connection is the session owner (a host device) vs a guest, vs a
  // public listener. Authoritative + un-forgeable: we strip any client-supplied `host`/`pub`
  // and set them ourselves from the authenticated identity. Guests can't grant themselves
  // control, and a public listener is read-only (see the DO).
  const isHost = !!user && user.id === hostId && !asPublic;
  url.searchParams.delete("host");
  url.searchParams.delete("pub");
  if (isHost) url.searchParams.set("host", "1");
  if (asPublic) url.searchParams.set("pub", "1");

  // Follow edge for the DO (which has no DB): does THIS authenticated connection follow the
  // room's host? Resolved here once, handed down as an un-forgeable `fol` flag (stripped like
  // host/pub), so the DO can gate follower-only features (e.g. chat) without a DB binding.
  url.searchParams.delete("fol");
  if (user && user.id !== hostId && env.DB) {
    try {
      if (await isFollowing(env.DB, user.id, hostId)) url.searchParams.set("fol", "1");
    } catch {
      /* graph unavailable → treat as non-follower */
    }
  }
  // The connecting account id, handed to the DO un-forgeably (stripped + re-set). SERVER-ONLY on
  // the attachment, NEVER in the broadcast roster (a Peer stays device-scoped) — it exists solely
  // so the DO can attribute a room event (e.g. a chat @mention) to an account when it bridges a
  // notification back to the Worker. Anon connections carry none.
  url.searchParams.delete("acct");
  if (user) url.searchParams.set("acct", user.id);

  // Un-forgeable auto-admit grant (push-invite): the friend the host invited skips the knock.
  // Stripped + only set when a real grant was just consumed above — a client can't fake it.
  url.searchParams.delete("invited");
  if (invited) url.searchParams.set("invited", "1");

  // Presence: any authenticated socket attaching (own rig, a jam, or a signed-in listen) means
  // this user is online to their friends. Transition write, best-effort (never blocks the upgrade);
  // the matching offline is bridged from the room DO when their last socket drops (/internal/presence).
  if (user && env.DB) ctx.waitUntil(setPresenceOnline(env.DB, user.id).catch(() => {}));

  // D2 relay tier: when RELAY_SHARDS>0, an anonymous pub-listener is sharded onto one of R
  // RelayRoom DOs (by hash(device)) instead of piling onto the master — the master pushes the
  // crowd frames to the shards. Participants always hit the master. Off (0) = the live path.
  const shards = Math.max(0, Math.min(64, Number(env.RELAY_SHARDS) || 0));
  if (asPublic && shards > 0 && env.RELAY) {
    const device = url.searchParams.get("device") || "";
    const idx = hashStr(device) % shards;
    url.searchParams.set("host_id", hostId);
    url.searchParams.set("idx", String(idx));
    const relay = env.RELAY.get(env.RELAY.idFromName(`relay:${hostId}:${idx}`));
    return relay.fetch(new Request(url.toString(), req));
  }
  url.searchParams.set("rid", hostId); // master needs its host id to address the relays
  const stub = env.ROOM.get(env.ROOM.idFromName(`home:${hostId}`));
  return stub.fetch(new Request(url.toString(), req));
}

// Stable non-crypto hash for sharding a device id across relays (FNV-1a).
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// G4 — shareable links unfurl: build OpenGraph/Twitter meta for /@handle + /set/:id so a pasted
// link shows a rich card (title + cover + description) on social/chat, then escapes htl. The SPA
// is otherwise meta-blind (one static index.html); we inject these tags server-side per URL.
function ogEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function ogBlock(o: { title: string; desc: string; img: string; url: string; large: boolean }): string {
  const tags = [
    `<meta property="og:title" content="${ogEsc(o.title)}">`,
    `<meta property="og:description" content="${ogEsc(o.desc)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Handling The Loop">`,
    `<meta property="og:url" content="${ogEsc(o.url)}">`,
    `<meta name="twitter:card" content="${o.large && o.img ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${ogEsc(o.title)}">`,
    `<meta name="twitter:description" content="${ogEsc(o.desc)}">`,
    `<meta name="description" content="${ogEsc(o.desc)}">`,
  ];
  if (o.img) {
    tags.push(`<meta property="og:image" content="${ogEsc(o.img)}">`);
    tags.push(`<meta name="twitter:image" content="${ogEsc(o.img)}">`);
  }
  return tags.join("\n");
}
async function ogMetaFor(url: URL, env: Env): Promise<string | null> {
  if (!env.DB) return null;
  const path = decodeURIComponent(url.pathname); // some hosts encode /@h as /%40h
  const handleM = path.match(/^\/@([A-Za-z0-9_]{1,20})$/);
  if (handleM) {
    await ensureIdentityColumns(env.DB);
    const u = await userByHandle(env.DB, foldHandle(handleM[1]));
    if (!u || !u.handle) return null;
    const name = u.display_name || `@${u.handle}`;
    const here = `${url.origin}/@${u.handle}`;
    const img = u.avatar_url || "";
    // State-aware: a crawler is anonymous, so the card reflects the HOST's state only (live vs
    // profile) — never the viewer ("X invited you" lives in the bell, not an OG card). Live → the
    // "join the set" card; otherwise the static profile card.
    const room = await liveRoomStatus(env.DB, u.id).catch(() => null);
    if (room?.live) {
      const track = room.npTitle ? `${room.npArtist ? `${room.npArtist} — ` : ""}${room.npTitle}` : "now playing";
      const desc = `${track} · ${room.listeners} listening — tune in on Handling The Loop`;
      return ogBlock({ title: `🔴 ${name} is live`, desc, img, url: here, large: true });
    }
    return ogBlock({ title: name, desc: u.bio || `${name} on Handling The Loop`, img, url: here, large: false });
  }
  const setM = path.match(/^\/set\/([A-Za-z0-9-]{6,40})$/);
  if (setM) {
    await ensureSetsTable(env.DB);
    const s = await getSet(env.DB, setM[1]);
    if (!s || s.status !== "published") return null;
    const mins = Math.max(1, Math.round(s.duration / 60000));
    const desc = `${s.tracks} track${s.tracks === 1 ? "" : "s"} · ~${mins} min — replay it on Handling The Loop`;
    const img = s.coverVideo ? `${url.origin}/api/art/${s.coverVideo}` : ""; // same-origin R2 art (absolute for crawlers)
    return ogBlock({ title: s.title || "A DJ set", desc, img, url: `${url.origin}/set/${s.id}`, large: true });
  }
  return null;
}
// The default card for the homepage (and any page that isn't a share link) — a rich, accurate
// description so a search / answer-engine crawler (which fetches the raw HTML and never runs the
// SPA) and a pasted link both get the real pitch instead of the bare shell. Share links override it.
function defaultOgMeta(url: URL): string {
  return ogBlock({
    title: "Handling The Loop — Free Online DJ Software",
    desc: "Free browser DJ app: two decks, real stem separation (isolate vocals, drums, bass), beat sync, key detection, looping, effects, a sampler, recording and live sharing. No install — works on desktop and mobile.",
    img: "",
    url: `${url.origin}/`,
    large: true,
  });
}

// ★ THE INTERNAL BRIDGE'S GUARD, in one place. Three things it has to get right:
//
//  1. A DEDICATED SECRET where one exists. The bridge shipped bearing TOKEN_ENC_KEY, the key that
//     encrypts OAuth tokens at rest — so the at-rest key rides in a request header on every
//     mention and every presence drop, and anything that ever logs headers logs it. INTERNAL_SECRET
//     takes over when set; the fallback keeps existing deployments working until it is.
//  2. CONSTANT TIME. A `!==` on a secret leaks its prefix through timing. The window is small over
//     a network and the fix is four lines, so there is no argument for keeping the compare.
//  3. FAIL CLOSED on a missing secret, which it already did.
function internalSecret(env: Env): string {
  return env.INTERNAL_SECRET || env.TOKEN_ENC_KEY || "";
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false; // length is not secret; the contents are
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function internalAuthed(req: Request, env: Env): boolean {
  const secret = internalSecret(env);
  const given = req.headers.get("x-htl-internal") ?? "";
  return !!secret && timingSafeEqual(given, secret);
}

// DO→Worker notification bridge (Epic I, Slice 7). The room DjRoom has no D1, so when a room
// event needs to write a notification (a chat @mention) it POSTs here. Guarded by an internal
// shared secret (TOKEN_ENC_KEY, already provisioned for both the Worker and its DOs) — an
// external caller can't forge it. Resolves @handle→user, refuses self + either-way blocks, and
// records the event. Inert if the secret isn't configured (plain `vite` dev, no rooms anyway).
async function handleInternalNotify(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (!internalAuthed(req, env)) return json(403, { error: "forbidden" });
  if (!env.DB) return json(200, { ok: false });
  const b = (await req.json().catch(() => ({}))) as { toHandle?: string; actorId?: string; kind?: string };
  const kind = b.kind === "mention" ? "mention" : null;
  if (!kind || !b.toHandle) return json(400, { error: "bad request" });
  const recipient = await userByHandle(env.DB, foldHandle(b.toHandle));
  if (!recipient?.handle) return json(200, { ok: false }); // unknown handle → no-op
  if (b.actorId && b.actorId === recipient.id) return json(200, { ok: false }); // don't notify yourself
  if (b.actorId && (await blockedEither(env.DB, b.actorId, recipient.id))) return json(200, { ok: false });
  await addNotification(env.DB, { userId: recipient.id, kind, actorId: b.actorId ?? null }).catch(() => {});
  return json(200, { ok: true });
}

// Presence-offline bridge: the room DO posts here when an account's last socket dropped and stayed
// gone past the grace. Same internal secret guard as /internal/notify. The write is LWW-guarded on
// `closedAt` (setPresenceOffline only lands if nothing newer happened), so an account that
// reconnected on another DO in the meantime can't be stomped offline.
async function handleInternalPresence(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (!internalAuthed(req, env)) return json(403, { error: "forbidden" });
  if (!env.DB) return json(200, { ok: false });
  const b = (await req.json().catch(() => ({}))) as { acct?: string; closedAt?: number };
  if (!b.acct) return json(400, { error: "bad request" });
  await setPresenceOffline(env.DB, b.acct, b.closedAt ?? Date.now()).catch(() => {});
  return json(200, { ok: true });
}

// The DjRoom Durable Object must be exported from the Worker entry so the runtime
// can find the class named in wrangler.jsonc's durable_objects binding.
export { DjRoom } from "../server/room";
export { RelayRoom } from "../server/relayRoom"; // D2 crowd shards (dormant unless RELAY_SHARDS>0)

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/room") return handleRoom(req, env, ctx);
    if (url.pathname === "/internal/notify") return handleInternalNotify(req, env);
    if (url.pathname === "/internal/presence") return handleInternalPresence(req, env);
    if (url.pathname.startsWith("/api/")) return handleApi(url, req, env, ctx);
    // Static SPA — but stamp every response with cross-origin-isolation headers so
    // `crossOriginIsolated` is true in the browser. That unlocks SharedArrayBuffer
    // and threaded WASM, so the desktop stem-separation workers (ORT threads,
    // demucs-rs) run multi-threaded instead of single-threaded (which stalls and
    // can get the tab killed). `credentialless` keeps cross-origin subresources —
    // YouTube thumbnails, the onnxruntime CDN, HuggingFace weights — loading.
    const res = await env.ASSETS.fetch(req);
    const headers = new Headers(res.headers);
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "credentialless");
    // Baseline security headers (CSP, nosniff, framing, referrer, permissions).
    // CSP's script-src has no 'unsafe-inline', so an injected <script> can't run —
    // turning any residual HTML-injection from account-takeover into a no-op.
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    // Inject per-page meta into the SPA shell: a rich share card for /@handle + /set/:id links, and
    // the default marketing description everywhere else — so every HTML page carries an accurate
    // description/OG for search + answer-engine crawlers (which see the shell, not the running app).
    let body: BodyInit | null = res.body;
    if ((res.headers.get("content-type") || "").includes("text/html")) {
      const meta = (await ogMetaFor(url, env).catch(() => null)) || defaultOgMeta(url);
      body = (await res.text()).replace("</head>", `${meta}\n</head>`);
    }
    return new Response(body, { status: res.status, statusText: res.statusText, headers });
  },
};
