# Accounts, connections, and the library

`server/accounts.ts` (1.1k lines) plus `src/htl/library/`. The settings/bank half
of account sync is in [sync.md](./sync.md); this is identity, connected services,
and the one store that is not a settings blob.

## The posture

**Signed out, the app is whole.** Everything works locally; nothing leaves the
browser. Signing in adds *continuity* (your setup follows you) and *society*
(sessions, profiles, the community pool) — it is not a gate on the product.

`accounts.ts` owns every `/api/auth/*` and `/api/me/*` route and returns `null` for
anything it does not own, so the main router continues. It needs D1, Google web
OAuth credentials, and `TOKEN_ENC_KEY`.

## Two different OAuth flows, on purpose

| | Used for | Why |
|---|---|---|
| **device-code** (`oauth.ts`) | YouTube playback identity | it is the *TV* client. You type a short code at google.com/device; no redirect, works from a deck with no keyboard |
| **web redirect** (`googleAuth`, `spotifyAuth`, `tidalAuth`) | signing in, connecting catalogues | ordinary browser flow; Tidal is PKCE |

Tokens live in the **user's browser** and are forwarded per request; they are not
stored server-side. Refresh is handled by `connections.ts`
(`getValidToken`/`getValidConnection`), which is the only place that should decide
a token is still good.

Spotify and Tidal are **catalogue-only** — DRM means we can never decode their
audio. They contribute metadata and playlists, which resolve to a YouTube id for
playback. That asymmetry is the whole reason the library needs an identity
function.

## The library, and why identity is hard

A track reaches the Collection from a bare id, a pasted URL, a search hit, or an
unresolved Spotify/Tidal row. Comparing raw `videoId` strings **double-adds** the
same recording — or worse, **collapses two distinct catalogue tracks** that both
carry an empty `videoId` until they resolve.

`identity.ts` gives one answer: `trackKey` = a real videoId if there is one, else
ISRC → `provider:id` → a normalized `artist|title`. **One identity function across
the whole library** — every surface that dedupes must call it rather than
reimplement it.

`canonicalVideoId` preserves case. YouTube ids are case-sensitive base64url;
lowercasing corrupts them. That is a one-line rule that has cost real bugs
elsewhere.

### Re-syncing a fuzzy playlist

`resync.ts` follows each song by its **source** identity, not by whichever YouTube
video it happened to match. A re-match drifts to a different video across runs, and
keying on that video is what accreted duplicates forever.

### The sync leg, and its scars

The Collection + playlists ride the same last-write-wins blob contract as settings,
on `/api/me/library` with a bigger cap. It has produced **two live data-loss bugs**,
both of the same shape: a re-sync pruned local rows against a **page-capped read**
of the remote, so anything past the cap looked deleted and was removed.

> The caps are safe *now* but not *solved*. Before touching `resync.ts`, read its
> header and the tests in `resync.test.ts`. The rule that keeps it safe: **never
> prune against a partial read.** If you cannot prove you saw everything, do not
> delete anything.

## Privacy surface

The social features carry real obligations and they are implemented, not aspirational:
account deletion cascades (`/api/me/delete`), blocks, private accounts, presence
limited to friends, reserved handles, moderation and takedown routes (on the
separate Access-gated admin Worker), and a Workers-AI gate on user content. See
[security-handoff.md](./security-handoff.md) — dated, and its open items have not
been re-verified since July.
