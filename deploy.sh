#!/usr/bin/env bash
# Build + deploy to the edge. Vite copies ALL of public/models (~950MB) into
# dist/, which is far too big to ship AND exceeds Cloudflare's 25 MiB/asset limit.
# Stem weights now load cross-origin from HuggingFace at runtime — Open-Unmix from
# our repo (asuramaya/htl-stems) and HT-Demucs from set-soft/audio_separation — so
# NOTHING under models/ needs to ship. Drop the whole dir.
set -euo pipefail
cd "$(dirname "$0")"

# --- pre-deploy gate: never ship red ---
# `pnpm run build` below already runs the src typecheck (tsc -b), so here we add the
# worker project's typecheck + the full test suite. Any failure aborts before the edge
# is touched. Skip with SKIP_TESTS=1 ./deploy.sh only for a known-green hotfix.
if [ "${SKIP_TESTS:-0}" != "1" ]; then
  echo "› pre-deploy gate: worker typecheck + tests"
  pnpm exec tsc -p tsconfig.node.json
  pnpm test
fi

pnpm run build

rm -rf dist/models

echo "dist size: $(du -sh dist | cut -f1)"
pnpm exec wrangler deploy
