// Seed the LOCAL dev D1 with a fake social graph so the people surfaces (search, PeopleList,
// Discover friends-online + live directory, profile counts, knock/invite) have real data to
// stress. Emits SQL to stdout — apply to the local D1 with:
//
//   node scripts/seed-social.mjs | tee /tmp/seed-social.sql >/dev/null
//   npx wrangler d1 execute htl-db --local --file=/tmp/seed-social.sql
//
// or the one-liner in scripts (see the banner this prints on stderr). Re-runnable: it wipes
// prior `seed-%` rows first, so it converges instead of duplicating.
//
// The graph is anchored to a dev-login account (google_sub `dev:<handle>`, default `hector`).
// Log in as that name — http://localhost:8787/api/auth/dev?name=Hector — and you immediately
// have followers, following, mutuals (friends), some online, some live. Pass --handle=foo to
// anchor a different dev name.
//
// DEV-ONLY. Every row is id-prefixed `seed-` (users) so a re-run / teardown is a LIKE wipe and
// it never touches your real account or sessions. NOT for the remote DB.

const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.slice(k.length + 3) : d;
};
const ANCHOR = (arg("handle", "hector") || "hector").toLowerCase().replace(/[^a-z0-9_]/g, "") || "hector";
const N = Number(arg("n", "48"));

// --- deterministic PRNG so a re-run is stable -----------------------------------------------
let _s = 0x9e3779b9;
function rng() {
  _s |= 0;
  _s = (_s + 0x6d2b79f5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const chance = (p) => rng() < p;
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// --- name / flavour pools -------------------------------------------------------------------
const FIRST = [
  "Nova", "Kairos", "Vela", "Sable", "Onyx", "Lyra", "Marlo", "Zephyr", "Cleo", "Rune",
  "Indra", "Sol", "Echo", "Juno", "Basso", "Mira", "Dax", "Vera", "Koa", "Nyx",
  "Remy", "Tindra", "Caz", "Loop", "Akira", "Wrenn", "Halo", "Dune", "Pyx", "Sora",
  "Vox", "Mako", "Ivo", "Selah", "Bram", "Cyra", "Odi", "Faye", "Grim", "Lux",
  "Nael", "Ria", "Tovi", "Uma", "Cass", "Drey", "Ona", "Quill", "Suki", "Ravi",
  "Neve", "Orbit", "Plur", "Sahar", "Tycho", "Vada", "Wilo", "Yara", "Zane", "Bex",
];
const SUR = [
  "Kane", "Vance", "Mori", "Reyes", "Frost", "Adler", "Okafor", "Sol", "Dane", "Reza",
  "Voss", "Hale", "Mensah", "Cruz", "Berg", "Nakai", "Diaz", "Lund", "Sato", "Ali",
  "Marsh", "Quinn", "Roux", "Tan", "Wilde", "Yusuf", "Zola", "Bianchi", "Cole", "Dubois",
];
const GENRES = [
  "house", "techno", "disco", "garage", "DnB", "breaks", "ambient", "afro house",
  "minimal", "dub techno", "electro", "trance", "amapiano", "hip hop", "funk", "edits",
];
const BIO_TEMPLATES = [
  (g) => `${g} all night. resident at no club in particular.`,
  (g) => `${g} edits + crate digging. warm-up specialist.`,
  (g) => `i play ${g}. probably too loud.`,
  (g) => `${g} / sunset sets / blends only.`,
  (g) => `${g} head. b2b enjoyer. no requests (ok maybe).`,
  (g) => `pushing ${g} since the basement days.`,
  () => "",
];
const TRACKS = [
  ["Floorplan", "Never Grow Old"], ["Peggy Gou", "It Makes You Forget"], ["Folamour", "Devoted to You"],
  ["DJ Koze", "Pick Up"], ["Bicep", "Glue"], ["Fred again..", "Marea"], ["Caribou", "Never Come Back"],
  ["Moodymann", "Shades of Jae"], ["Disclosure", "You & Me"], ["Hot Chip", "Over and Over"],
  ["Jamie xx", "Gosh"], ["Four Tet", "Two Thousand and Seventeen"], ["Black Coffee", "Drive"],
  ["Kaytranada", "Lite Spots"], ["Overmono", "So U Kno"], ["Skee Mask", "Rdvnja"],
  ["Roisin Murphy", "Murphys Law"], ["Mall Grab", "Spirit Level"], ["DJ Seinfeld", "U"],
  ["Honey Dijon", "Downtown"], ["Octo Octa", "Move Your Body"], ["Ross From Friends", "Talk To Me"],
];

const esc = (s) => `'${String(s).replace(/'/g, "''")}'`;
const NOW = Date.now();
const DAY = 86_400_000;
const FAR = NOW + 400 * DAY; // far-future last_seen → seeded live rooms never age out of the directory

// --- build users ----------------------------------------------------------------------------
const usedHandles = new Set([ANCHOR]);
const users = [];
for (let i = 0; i < N; i++) {
  const name = chance(0.5) ? `${pick(FIRST)} ${pick(SUR)}` : `${chance(0.4) ? "DJ " : ""}${pick(FIRST)}`;
  let base = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 18) || `dj${i}`;
  let handle = base;
  let n = 1;
  while (usedHandles.has(handle)) handle = `${base.slice(0, 16)}${++n}`;
  usedHandles.add(handle);
  const genre = pick(GENRES);
  const display = chance(0.12) ? null : chance(0.5) ? name : `${name}`; // some null → @handle fallback path
  users.push({
    id: `seed-u-${String(i).padStart(3, "0")}`,
    sub: `seed:${i}`,
    handle,
    display,
    bio: pick(BIO_TEMPLATES)(genre),
    avatar: `https://api.dicebear.com/9.x/bottts-neutral/svg?seed=${handle}`,
    created: NOW - Math.floor(rng() * 600) * DAY - DAY,
  });
}

const ME = `(SELECT id FROM users WHERE google_sub='dev:${ANCHOR}')`;
const lines = [];
const P = (s) => lines.push(s);

// --- teardown (idempotent) ------------------------------------------------------------------
P(`-- seed-social: ${N} fake DJs anchored to dev:${ANCHOR}  (generated ${new Date(NOW).toISOString()})`);
P("PRAGMA foreign_keys=OFF;");
P("DELETE FROM follows WHERE follower_id LIKE 'seed-%' OR followee_id LIKE 'seed-%';");
P("DELETE FROM blocks  WHERE blocker_id  LIKE 'seed-%' OR blocked_id  LIKE 'seed-%';");
P("DELETE FROM presence WHERE user_id LIKE 'seed-%';");
P("DELETE FROM rooms    WHERE host_id LIKE 'seed-%';");
P("DELETE FROM session_invites WHERE host_id LIKE 'seed-%' OR guest_id LIKE 'seed-%';");
P("DELETE FROM users    WHERE id LIKE 'seed-%';");

// --- ensure the anchor (your dev account) exists so follows can attach even before first login -
P(
  `INSERT INTO users (id, google_sub, email, name, created_at, last_login, handle, handle_folded, display_name, handle_set_at)\n` +
    `SELECT 'seed-anchor-${ANCHOR}', 'dev:${ANCHOR}', '${ANCHOR}@dev.local', ${esc(ANCHOR)}, ${NOW}, ${NOW}, ${esc(ANCHOR)}, ${esc(ANCHOR)}, ${esc(ANCHOR[0].toUpperCase() + ANCHOR.slice(1))}, ${NOW}\n` +
    `WHERE NOT EXISTS (SELECT 1 FROM users WHERE google_sub='dev:${ANCHOR}');`,
);

// --- users -------------------------------------------------------------------------------
for (const u of users) {
  P(
    `INSERT INTO users (id, google_sub, email, name, avatar, created_at, last_login, handle, handle_folded, display_name, avatar_url, bio, handle_set_at) VALUES (` +
      `${esc(u.id)}, ${esc(u.sub)}, ${esc(u.handle + "@seed.local")}, ${esc(u.display || u.handle)}, NULL, ${u.created}, ${u.created}, ` +
      `${esc(u.handle)}, ${esc(u.handle.toLowerCase())}, ${u.display ? esc(u.display) : "NULL"}, ${esc(u.avatar)}, ${u.bio ? esc(u.bio) : "NULL"}, ${u.created});`,
  );
}

// --- follow graph among fakes ----------------------------------------------------------------
const ids = users.map((u) => u.id);
const follow = new Set(); // "a|b" = a follows b
const addF = (a, b) => {
  if (a !== b) follow.add(`${a}|${b}`);
};
for (const u of users) {
  const out = 3 + Math.floor(rng() * 12); // 3..14 follows
  for (const t of shuffle(ids).slice(0, out)) addF(u.id, t);
}

// --- wire the anchor in: following / followers / mutuals -------------------------------------
const roster = shuffle(ids);
const iFollow = roster.slice(0, 24); // I follow these
const mutuals = iFollow.filter(() => chance(0.7)); // ~70% follow back → friends
const followersOnly = roster.slice(24, 38); // these follow me, I don't follow back
const meFollowsSql = [];
const followsMeSql = [];
for (const t of iFollow) meFollowsSql.push(t);
for (const t of new Set([...mutuals, ...followersOnly])) followsMeSql.push(t);

// --- presence: a slice online (mutuals weighted so friends-online populates) ----------------
const onlineSet = new Set();
for (const t of mutuals) if (chance(0.65)) onlineSet.add(t); // friends online
for (const t of shuffle(ids).slice(0, 10)) onlineSet.add(t); // plus some randoms

// --- live rooms: some live now (a few of them ones I follow → "from people you follow") ------
const liveSet = new Set();
for (const t of shuffle(mutuals).slice(0, 3)) liveSet.add(t); // followed + live
for (const t of shuffle(ids).slice(0, 4)) liveSet.add(t); // public live
for (const t of liveSet) onlineSet.add(t); // live implies online

// --- blocks: prove search/list exclusion ----------------------------------------------------
const iBlock = roster.slice(38, 40); // I block these → must NOT appear in my search/lists
const blocksMe = roster[40]; // this one blocks me → also excluded from friends/live

// emit follows (fake↔fake)
for (const k of follow) {
  const [a, b] = k.split("|");
  P(`INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (${esc(a)}, ${esc(b)}, ${NOW - Math.floor(rng() * 200) * DAY});`);
}
// emit anchor follows
for (const t of meFollowsSql)
  P(`INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (${ME}, ${esc(t)}, ${NOW - Math.floor(rng() * 60) * DAY});`);
for (const t of followsMeSql)
  P(`INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (${esc(t)}, ${ME}, ${NOW - Math.floor(rng() * 60) * DAY});`);

// presence
for (const u of users)
  P(`INSERT INTO presence (user_id, online, updated_at) VALUES (${esc(u.id)}, ${onlineSet.has(u.id) ? 1 : 0}, ${NOW});`);

// rooms
for (const t of liveSet) {
  const [artist, title] = pick(TRACKS);
  P(
    `INSERT INTO rooms (host_id, title, genre, live, listeners, np_title, np_artist, started_at, last_seen) VALUES (` +
      `${esc(t)}, ${esc("live set")}, ${esc(pick(GENRES))}, 1, ${1 + Math.floor(rng() * 80)}, ${esc(title)}, ${esc(artist)}, ${NOW - Math.floor(rng() * 90) * 60_000}, ${FAR});`,
  );
}

// blocks
for (const t of iBlock) P(`INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (${ME}, ${esc(t)}, ${NOW});`);
P(`INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (${esc(blocksMe)}, ${ME}, ${NOW});`);

P("PRAGMA foreign_keys=ON;");

process.stdout.write(lines.join("\n") + "\n");

// human summary on stderr (won't pollute the SQL on stdout)
const er = (s) => process.stderr.write(s + "\n");
er(`\n  seeded ${N} fake DJs · anchor=dev:${ANCHOR}`);
er(`  you follow ${iFollow.length} · friends (mutual) ~${mutuals.length} · followers-only ${followersOnly.length}`);
er(`  online now: ${onlineSet.size} · live rooms: ${liveSet.size} · you block ${iBlock.length} · 1 blocks you`);
er(`\n  apply:  npx wrangler d1 execute htl-db --local --file=/tmp/seed-social.sql`);
er(`  login:  http://localhost:8787/api/auth/dev?name=${ANCHOR[0].toUpperCase() + ANCHOR.slice(1)}\n`);
