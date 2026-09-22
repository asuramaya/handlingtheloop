#!/usr/bin/env bash
# Build + deploy to the edge. Vite copies ALL of public/models (~950MB) into
# dist/, which is far too big to ship AND exceeds Cloudflare's 25 MiB/asset limit.
# Stem weights now load cross-origin from HuggingFace at runtime — Open-Unmix from
# our repo (asuramaya/htl-stems) and HT-Demucs from set-soft/audio_separation — so
# NOTHING under models/ needs to ship. Drop the whole dir.
set -euo pipefail
cd "$(dirname "$0")"

# --- pre-deploy gate: never ship red ---
# This used to name the projects itself — "the src typecheck (tsc -b) … plus the worker
# project's typecheck" — and ran `tsc -p tsconfig.node.json` directly. Then 747b4a0 added a
# THIRD project (tsconfig.scripts.json, for the fxlab/joglab harnesses, which had been outside
# every tsconfig) and this gate did not grow. A hand-listed roster in the LAST thing that runs
# before shipping is the worst place for one: it fails silently, in the direction nobody checks,
# at the moment nobody is looking. So the gate now calls the single source of truth — whatever
# `pnpm typecheck` covers is what ships — and adding a project can no longer miss it.
# Any failure aborts before the edge is touched. Skip with SKIP_TESTS=1 ./deploy.sh only for a
# known-green hotfix.
# --- the streaming-client tripwire's AGE, echoed, never asserted ---
# 6c430b35 watches yt-dlp's visionos entry because CLIENT_CASCADE has exactly one client and no
# eligible second one. The check itself is `node scripts/ytclient-watch.mjs`; `--record` leaves a
# receipt. Nobody needs its age on a Tuesday — the moment it is load-bearing is the moment someone
# ships, which is here.
#
# It is an ECHO, not an assertion, and that is the whole design: a staleness check that could fail
# would block a deploy over a non-problem at the one moment nobody wants to debug a tripwire, and a
# watch that breaks deploys is a worse instrument than one that decays. `|| true` guarantees it
# cannot take the build down even if the receipt is missing, malformed, or the parser is wrong.
node -e '
  const fs = require("node:fs");
  try {
    const r = JSON.parse(fs.readFileSync("scripts/ytclient-watch.last.json", "utf8"));
    const days = Math.floor((Date.now() - Date.parse(r.when)) / 86400000);
    console.log(`› streaming-client tripwire: ${r.fired ? "FIRED" : "quiet"}, last run ${days}d ago${days > 14 ? " — consider `node scripts/ytclient-watch.mjs`" : ""}`);
  } catch {
    console.log("› streaming-client tripwire: no receipt — run `node scripts/ytclient-watch.mjs --record`");
  }
' || true

if [ "${SKIP_TESTS:-0}" != "1" ]; then
  echo "› pre-deploy gate: every typecheck project + tests"
  pnpm typecheck
  pnpm test
fi

pnpm run build

rm -rf dist/models

echo "dist size: $(du -sh dist | cut -f1)"
pnpm exec wrangler deploy
