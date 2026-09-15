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
  { id: "u_synclab_a", sid: "sid_synclab_a", handle: "synclaba", name: "Synclab A", sub: "dev_synclab_a" },
  { id: "u_synclab_b", sid: "sid_synclab_b", handle: "synclabb", name: "Synclab B", sub: "dev_synclab_b" },
];

// INSERT OR REPLACE so re-running is safe. Columns are NAMED, never positional — `users` gained
// handle/handle_folded/handle_set_at in migration 0012, so a positional VALUES list written against
// the 0001 shape would silently land values in the wrong columns.
//
// google_sub is TEXT UNIQUE and DISTINCT per user rather than NULL: SQLite permits many NULLs in a
// unique index so NULL would work today, but a distinct value keeps the fixture correct if that
// column ever becomes NOT NULL, and costs nothing. (Deckard's correction.)
//
// handle + handle_folded are set because userBySession SELECTS them and the public-room path
// resolves a host by @handle — a host with a NULL handle is addressable by invite code but not by
// name, which would look like a routing bug the first time we tried ?room=@synclabb.
// handle_folded carries the unique index (idx_users_handle_folded), so it must match the fold.
const sql = [
  ...USERS.map(
    (u) =>
      `INSERT OR REPLACE INTO users (id,google_sub,email,name,avatar,created_at,last_login,handle,handle_folded,handle_set_at) ` +
      `VALUES ('${u.id}','${u.sub}','${u.id}@local.test','${u.name}',NULL,${now},${now},'${u.handle}','${u.handle}',${now});`,
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

// Mint the HOST's invite link, so the whole two-party setup is one command instead of a manual
// POST. /api/room/invite is POST-only, requires the host's session cookie, and returns
// { code, url: "<origin>/?join=<code>" } — the code only NAMES a session, it does not grant
// anything (the WS upgrade is authed per connection), which is why it is safe to print.
const inviteFor = process.argv.includes("--invite") ? process.argv[process.argv.indexOf("--invite") + 1] : null;
if (inviteFor) {
  const u = USERS.find((x) => x.id === inviteFor || x.handle === inviteFor);
  if (!u) {
    console.error(`✗ unknown user ${inviteFor} — expected one of ${USERS.map((x) => x.id).join(", ")}`);
    process.exit(2);
  }
  const origin = process.env.HTL_ORIGIN || "http://localhost:8787";
  const res = await fetch(`${origin}/api/room/invite`, {
    method: "POST",
    headers: { cookie: `htl_session=${u.sid}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 401 here means the cookie did not resolve to a user — i.e. the seed did not take, or the
    // worker is pointed at a different D1 than the one seeded. Say which, rather than "failed".
    console.error(`✗ invite failed ${res.status}:`, body);
    console.error("  401 => the seed is not visible to THIS worker (different D1, or --local not used)");
    process.exit(2);
  }
  console.log(`
${u.name} hosts. Invite URL for the other side:
  ${body.url}`);
}
