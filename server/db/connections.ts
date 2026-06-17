// Service connections: encrypted OAuth token storage (Google/Spotify/Tidal).
// Tokens are encrypted (crypto.ts) before they touch a column.
import { decrypt, encrypt } from "../crypto";
import { type D1Database, type Provider, type TokenSet, now, uuid } from "./core";

/** Which services a user has linked (for the UI). */
export async function listConnections(db: D1Database, userId: string): Promise<Provider[]> {
  const r = await db
    .prepare("SELECT provider FROM connections WHERE user_id = ?")
    .bind(userId)
    .all<{ provider: Provider }>();
  return (r.results ?? []).map((x) => x.provider);
}

/** Upsert a service connection, encrypting tokens at rest. */
export async function saveConnection(
  db: D1Database,
  userId: string,
  provider: Provider,
  tokens: TokenSet,
  encKey: string,
): Promise<void> {
  const enc = await encrypt(tokens.access_token, encKey);
  const encRefresh = tokens.refresh_token ? await encrypt(tokens.refresh_token, encKey) : null;
  const id = uuid();
  // Keep an existing refresh token if this grant didn't return a new one (Google
  // only returns refresh_token on first consent).
  await db
    .prepare(
      `INSERT INTO connections
         (id, user_id, provider, provider_user_id, access_token, refresh_token, expires_at, scope, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id, provider) DO UPDATE SET
         provider_user_id = COALESCE(excluded.provider_user_id, connections.provider_user_id),
         access_token     = excluded.access_token,
         refresh_token    = COALESCE(excluded.refresh_token, connections.refresh_token),
         expires_at       = excluded.expires_at,
         scope            = excluded.scope,
         updated_at       = excluded.updated_at`,
    )
    .bind(
      id,
      userId,
      provider,
      tokens.provider_user_id ?? null,
      enc,
      encRefresh,
      tokens.expires_at ?? null,
      tokens.scope ?? null,
      now(),
      now(),
    )
    .run();
}

export interface DecryptedConnection {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scope: string | null;
  providerUserId: string | null;
}

/** Fetch + decrypt a connection's tokens (null if the user hasn't linked it). */
export async function getConnection(
  db: D1Database,
  userId: string,
  provider: Provider,
  encKey: string,
): Promise<DecryptedConnection | null> {
  const row = await db
    .prepare(
      "SELECT access_token, refresh_token, expires_at, scope, provider_user_id FROM connections WHERE user_id=? AND provider=?",
    )
    .bind(userId, provider)
    .first<{
      access_token: string;
      refresh_token: string | null;
      expires_at: number | null;
      scope: string | null;
      provider_user_id: string | null;
    }>();
  if (!row) return null;
  return {
    accessToken: await decrypt(row.access_token, encKey),
    refreshToken: row.refresh_token ? await decrypt(row.refresh_token, encKey) : null,
    expiresAt: row.expires_at,
    scope: row.scope,
    providerUserId: row.provider_user_id,
  };
}

export async function deleteConnection(db: D1Database, userId: string, provider: Provider): Promise<void> {
  await db.prepare("DELETE FROM connections WHERE user_id=? AND provider=?").bind(userId, provider).run();
}
