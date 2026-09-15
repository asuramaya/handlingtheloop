// TWO LOCAL SIGNED-IN USERS, so a two-party session can be driven without any credentials.
//
// ★ WHY THIS IS NEEDED. A room is a Durable Object keyed on the HOST's user id, and
// worker/index.ts says it plainly: "Signed-in users land in their OWN session by default, or in a
// HOST's session when they open an invite code. ANONYMOUS users may join too, but ONLY via a valid
// invite code (they can't own a session)." So a two-party test needs at least one signed-in host.
// server/api.ts's DEV_AUTH is Vite-middleware only and single-user, and Vite does not serve
// /api/room at all — so `pnpm dev` cannot host a session. The Worker path has no dev bypass:
// worker/shared.ts's sessionUser is readSessionId(req) -> userBySession(env.DB, sid), full stop.
//
// ★ AND WHY IT IS NOT "CREATING AN ACCOUNT". A session is a ROW. userBySession joins `sessions` to
// `users` on an id and an expiry — nothing else is consulted. So we write two fixture rows into the
// LOCAL wrangler D1. There is no password, no OAuth flow, no third-party identity, no real person's
// data, and nothing leaves this machine. This is a seeded test fixture, not a credential. Against
// production D1 or a real login form it would be neither, and the answer there is to ask the
// operator instead.
//
// USAGE (with `pnpm worker` / wrangler dev running against --local D1):
//   node scripts/synclab/seed-two-users.mjs            # prints the SQL + the cookies to set
//   node scripts/synclab/seed-two-users.mjs --apply    # runs it through wrangler
//
// Then set cookie `htl_session` (SESSION_COOKIE, server/session.ts) to the printed id in each
// Chrome profile, on the wrangler-dev origin. A owns home:u_synclab_a and hosts; B joins by invite.
import { execFileSync } from "node:child_process";

const DAY = 86_400_000;
const now = Date.now();
const exp = now + 7 * DAY;

// Stable ids, so a re-seed is idempotent and both agents address the SAME users across runs —
// two harnesses seeding different ids is how "it synced for me" and "it did not for me" happen.
const USERS = [
  { id: "u_synclab_a", sid: "sid_synclab_a", handle: "synclaba", name: "Synclab A" },
  { id: "u_synclab_b", sid: "sid_synclab_b", handle: "synclabb", name: "Synclab B" },
];

// INSERT OR REPLACE so re-running is safe; google_sub is NULL (unique, and nothing reads it here).
const sql = [
  ...USERS.map(
    (u) =>
      `INSERT OR REPLACE INTO users (id,google_sub,email,name,avatar,created_at,last_login) ` +
      `VALUES ('${u.id}',NULL,'${u.id}@local.test','${u.name}',NULL,${now},${now});`,
  ),
  ...USERS.map(
    (u) =>
      `INSERT OR REPLACE INTO sessions (id,user_id,created_at,expires_at) ` +
      `VALUES ('${u.sid}','${u.id}',${now},${exp});`,
  ),
].join("\n");

console.log(sql);
console.log("\n-- cookies to set on the wrangler-dev origin --");
for (const u of USERS) console.log(`  ${u.name}: htl_session=${u.sid}`);

if (process.argv.includes("--apply")) {
  console.log("\napplying to LOCAL d1 (htl-db)…");
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "htl-db", "--local", "--command", sql],
    { encoding: "utf8", cwd: new URL("../..", import.meta.url).pathname },
  );
  console.log(out);
  // ★ POSITIVE CONTROL: prove the seed is READABLE THE WAY THE APP READS IT — the same join
  // userBySession performs, with the same expiry predicate. A successful INSERT is not evidence
  // that a login works; a row that the app's own query cannot return is a fixture that will fail
  // silently at handshake time and look like a sync bug.
  const check = execFileSync(
    "npx",
    [
      "wrangler", "d1", "execute", "htl-db", "--local", "--json", "--command",
      `SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id IN ('${USERS.map((u) => u.sid).join("','")}') AND s.expires_at > ${now};`,
    ],
    { encoding: "utf8", cwd: new URL("../..", import.meta.url).pathname },
  );
  const rows = JSON.parse(check)?.[0]?.results ?? [];
  console.log(`control: userBySession's own join returns ${rows.length}/2 users`, rows);
  if (rows.length !== USERS.length) {
    console.error("✗ the seed is NOT readable by the app's own query — do not start a run on it");
    process.exit(2);
  }
  console.log("✓ both sessions resolve to a user by the app's own query");
}
