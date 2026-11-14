#!/usr/bin/env node
// FEED THE BEAST: copy what the LOCAL dev server has amassed (community tracks, their analysis,
// lyrics, captions, and the cached audio / stems / cover art) into PRODUCTION, adding only what
// prod does not already have. Local stays a sandbox; this is the one bridge, run when you choose.
// (Operator, 2026-11-14: "how can i use prod's library locally so im feeding it … feeding the
// beast" → option C: a rerunnable feed.)
//
//   node scripts/feed-prod.mjs                 dry run: print what WOULD be copied (default)
//   node scripts/feed-prod.mjs --go            do it
//   node scripts/feed-prod.mjs --go --limit 10 a trial: only the first 10 missing tracks
//   node scripts/feed-prod.mjs --go --only db  rows only (or --only files)
//
// Rules, so a rerun is always safe:
//   • ADD, NEVER OVERWRITE. Database rows go in with INSERT OR IGNORE and only for tracks the prod
//     table does not hold at all; files only for tracks prod has never seen (audio, art) or for
//     stems prod's own manifest says it lacks.
//   • NEVER a taken-down track: anything in prod's or local's takedowns table is skipped.
//   • Uses the same Cloudflare login as ./deploy.sh (wrangler). Nothing else is touched: no users,
//   sessions, libraries, follows or any account data, local or prod.
import { DatabaseSync } from "node:sqlite";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DB_NAME = "htl-db";
const BUCKET = "htl-audio";
const PROD = "https://handlingtheloop.com";
const STEM_NAMES = ["vocals", "drums", "bass", "other"];
const TABLES = ["community_tracks", "track_analysis", "lyrics", "captions"];

const args = process.argv.slice(2);
const GO = args.includes("--go");
const arg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const LIMIT = Number(arg("--limit", "0")) || 0;
const ONLY = arg("--only", "all"); // all | db | files
const CONC = Number(arg("--concurrency", "6")) || 6;
const STATE = path.join(ROOT, ".wrangler/state/v3");

// ── local stores ──────────────────────────────────────────────────────────────────────────────────
const sqliteIn = (dir) => {
  const f = fs.readdirSync(dir).find((n) => n.endsWith(".sqlite") && n !== "metadata.sqlite");
  if (!f) throw new Error(`no sqlite file in ${dir}`);
  return new DatabaseSync(path.join(dir, f), { readOnly: true });
};
const local = sqliteIn(path.join(STATE, "d1/miniflare-D1DatabaseObject"));
const r2meta = sqliteIn(path.join(STATE, "r2/miniflare-R2BucketObject"));
const blobPath = (id) => path.join(STATE, "r2", BUCKET, "blobs", id);

// ── prod reads (wrangler) ─────────────────────────────────────────────────────────────────────────
const wrangler = (a, opts = {}) => execFileSync("npx", ["wrangler", ...a], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"], ...opts });
const prodQuery = (sql) => {
  // The D1 API drops the odd request ("fetch failed"); a read is safe to repeat.
  for (let i = 0; ; i++) {
    try {
      const out = wrangler(["d1", "execute", DB_NAME, "--remote", "--json", "--command", sql]);
      const j = JSON.parse(out.slice(out.indexOf("[")));
      return j[0]?.results ?? [];
    } catch (e) {
      if (i >= 3) throw e;
      execFileSync("sleep", [String(2 * (i + 1))]);
    }
  }
};
const prodIds = (table) => new Set(prodQuery(`SELECT DISTINCT video_id FROM ${table}`).map((r) => r.video_id));

console.log(`feed-prod ${GO ? "(GO: writing to production)" : "(dry run: nothing is written)"}\n`);
const takedown = new Set([...prodIds("takedowns"), ...local.prepare("SELECT video_id FROM takedowns").all().map((r) => r.video_id)]);

// ── what is missing ───────────────────────────────────────────────────────────────────────────────
const prodHas = Object.fromEntries(TABLES.map((t) => [t, prodIds(t)]));
const localCommunity = local.prepare("SELECT video_id FROM community_tracks ORDER BY cached_at").all().map((r) => r.video_id);
let candidates = localCommunity.filter((v) => !takedown.has(v) && !prodHas.community_tracks.has(v));
if (LIMIT) candidates = candidates.slice(0, LIMIT);
const cand = new Set(candidates);
// Rows: every table's rows for tracks prod lacks in THAT table (analysis can exist without a
// community row and vice versa). With --limit, only the trial's tracks.
const rowsFor = (table) => {
  const rows = local.prepare(`SELECT * FROM ${table}`).all();
  return rows.filter((r) => !takedown.has(r.video_id) && !prodHas[table].has(r.video_id) && (!LIMIT || cand.has(r.video_id)));
};
const plan = Object.fromEntries(TABLES.map((t) => [t, ONLY === "files" ? [] : rowsFor(t)]));

// Files: audio + art for tracks prod's community has never held; stems for any local stem set.
const objs = r2meta.prepare("SELECT key, blob_id, size, http_metadata FROM _mf_objects").all();
const fileJobs = [];
if (ONLY !== "db") {
  for (const o of objs) {
    const [kind, a, b] = o.key.split("/");
    if (kind === "a" || kind === "art") {
      if (cand.has(a)) fileJobs.push({ key: o.key, blob: o.blob_id, size: o.size, ct: JSON.parse(o.http_metadata || "{}").contentType });
    }
  }
  // stems: s/<model>/<id>/<name>; ask prod's own manifest which it already has
  const stemSets = new Map();
  for (const o of objs) {
    const [kind, model, id, name] = o.key.split("/");
    if (kind !== "s" || !STEM_NAMES.includes(name) || takedown.has(id)) continue;
    if (LIMIT && !cand.has(id)) continue;
    const k = `${model}/${id}`;
    if (!stemSets.has(k)) stemSets.set(k, []);
    stemSets.get(k).push(o);
  }
  let checked = 0;
  for (const [k, list] of stemSets) {
    const [model, id] = k.split("/");
    let present = [];
    try {
      const r = await fetch(`${PROD}/api/stems?v=${encodeURIComponent(id)}&model=${encodeURIComponent(model)}`);
      if (r.ok) present = (await r.json()).stems ?? (await Promise.resolve([]));
    } catch {
      /* unknown: treat as missing */
    }
    for (const o of list) if (!present.includes(o.key.split("/")[3])) fileJobs.push({ key: o.key, blob: o.blob_id, size: o.size, ct: "application/octet-stream" });
    if (++checked % 50 === 0) process.stdout.write(`  checked ${checked}/${stemSets.size} stem sets on prod\r`);
  }
}

// ── report ────────────────────────────────────────────────────────────────────────────────────────
const gb = (n) => `${(n / 1e9).toFixed(2)} GB`;
console.log(`skipping ${takedown.size} taken-down track(s)`);
console.log(`tracks local has that prod's community lacks: ${candidates.length}${LIMIT ? ` (limited to ${LIMIT})` : ""}`);
for (const t of TABLES) console.log(`  rows → ${t.padEnd(17)} ${plan[t].length}`);
const byKind = (p) => fileJobs.filter((j) => j.key.startsWith(p));
for (const [p, label] of [["a/", "audio"], ["s/", "stem files"], ["art/", "cover art"]]) {
  const js = byKind(p);
  console.log(`  files → ${label.padEnd(16)} ${String(js.length).padStart(4)}  ${gb(js.reduce((s, j) => s + j.size, 0))}`);
}
console.log(`  sample: ${candidates.slice(0, 5).map((v) => local.prepare("SELECT title, artist FROM community_tracks WHERE video_id=?").get(v)).map((r) => `${r?.title} — ${r?.artist}`).join(" | ")}`);
if (!GO) {
  fs.writeFileSync(path.join(os.tmpdir(), "feed-prod-titles.txt"), candidates.map((v) => { const r = local.prepare("SELECT title, artist FROM community_tracks WHERE video_id=?").get(v); return `${v}\t${r?.title}\t${r?.artist}`; }).join("\n"));
  console.log(`\nfull list of tracks: ${path.join(os.tmpdir(), "feed-prod-titles.txt")}\nrun again with --go to copy.`);
  process.exit(0);
}

// ── write: rows ───────────────────────────────────────────────────────────────────────────────────
const lit = (v) => (v == null ? "NULL" : typeof v === "number" || typeof v === "bigint" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "feed-prod-"));
for (const t of TABLES) {
  const rows = plan[t];
  for (let i = 0; i < rows.length; i += 150) {
    const chunk = rows.slice(i, i + 150);
    const cols = Object.keys(chunk[0]);
    const sql = chunk.map((r) => `INSERT OR IGNORE INTO ${t} (${cols.join(",")}) VALUES (${cols.map((c) => lit(r[c])).join(",")});`).join("\n");
    const f = path.join(tmp, `${t}-${i}.sql`);
    fs.writeFileSync(f, sql);
    wrangler(["d1", "execute", DB_NAME, "--remote", "--yes", "--file", f]);
    console.log(`  ${t}: ${Math.min(i + 150, rows.length)}/${rows.length}`);
  }
}

// ── write: files (a few wrangler uploads at a time) ──────────────────────────────────────────────
let done = 0;
let failed = 0;
const put = (j) =>
  new Promise((resolve) => {
    const a = ["wrangler", "r2", "object", "put", `${BUCKET}/${j.key}`, "--file", blobPath(j.blob), "--remote"];
    if (j.ct) a.push("--content-type", j.ct);
    const p = spawn("npx", a, { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      done++;
      if (code !== 0) {
        failed++;
        console.log(`\n  FAILED ${j.key}: ${err.split("\n").filter((l) => /error/i.test(l)).slice(0, 1).join("")}`);
      }
      process.stdout.write(`  files ${done}/${fileJobs.length}${failed ? ` (${failed} failed)` : ""}\r`);
      resolve();
    });
  });
const queue = [...fileJobs];
await Promise.all(Array.from({ length: CONC }, async () => { while (queue.length) await put(queue.shift()); }));
console.log(`\ndone: ${done - failed} file(s) copied, ${failed} failed. Rerun to retry anything that failed; it only adds what is missing.`);
